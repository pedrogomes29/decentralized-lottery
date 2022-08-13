const { assert, expect } = require("chai")
const { waffle, getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery Unit Tests", function () {
          let lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, deployer, interval
          const chainId = network.config.chainId
          beforeEach(async function () {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              lottery = await ethers.getContract("Lottery", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              lotteryEntranceFee = await lottery.getEntranceFee()
              interval = await lottery.getInterval()
          })

          describe("constructor", function () {
              it("initializes the lottery correctly", async function () {
                  const lotteryState = await lottery.getLotteryState()
                  assert.equal(lotteryState.toString(), "0")
                  assert.equal(interval, networkConfig[chainId]["interval"])
              })
          })

          describe("enterRaffle", function () {
              it("reverts when you don't pay enough", async function () {
                  await expect(lottery.enterRaffle()).to.be.revertedWith(
                      "Lottery__NotEnoughETHEntered"
                  )
              })

              it("records players when they enter", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  const playerFromContract = await lottery.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })

              it("emits event on enter", async function () {
                  await expect(lottery.enterRaffle({ value: lotteryEntranceFee })).to.emit(
                      lottery,
                      "LotteryEnter"
                  )
              })

              it("doesn't allow entrance when raffle is calculating", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  await lottery.performUpkeep([])
                  await expect(
                      lottery.enterRaffle({ value: lotteryEntranceFee })
                  ).to.be.revertedWith("Lottery__NotOpen")
              })
          })
          describe("checkUpkeep", function () {
              it("returns false if people haven't sent any ETH", async function () {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })

              it("returns false if lottery isn't open", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await lottery.performUpkeep([])
                  const lotteryState = await lottery.getLotteryState()
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert.equal(lotteryState.toString(), "1")
                  assert(!upkeepNeeded)
              })

              it("returns false if enough time hasn't passed", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })

              it("returns true if enough time has passed, has players, eth and is open", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(upkeepNeeded)
              })
          })
          describe("performUpkeep", function () {
              it("can only run if checkUpkeep is true", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const tx = await lottery.performUpkeep([])
                  assert(tx)
              })
              it("reverts when checkUpkeep is false", async function () {
                  await expect(lottery.performUpkeep([])).to.be.revertedWith(
                      `Lottery_UpkeepNotNeeded(${await lottery.provider.getBalance(
                          lottery.address
                      )}, ${await lottery.getNumberOfPlayers()}, 0)`
                  )
              })

              it("updates the raffle state, emits an event and calls the vrf coordinator", async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const txResponse = await lottery.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const { requestId } = txReceipt.events[1].args
                  const lotteryState = await lottery.getLotteryState()
                  assert(requestId.toNumber() > 0)
                  assert(lotteryState.toString() == "1")
              })
          })

          describe("fulfillRandomWords", function () {
              beforeEach(async function () {
                  await lottery.enterRaffle({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })

              it("can only be called after performUpkeep", async function () {
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)
                  ).to.be.revertedWith("nonexistent request")
                  await expect(
                      vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)
                  ).to.be.revertedWith("nonexistent request")
              })

              it("picks a winner, resets the lottery and sends the money", async function () {
                  const additionalEntrants = 3
                  const startingAccountIndex = 1
                  const accounts = await ethers.getSigners()
                  for (
                      let i = startingAccountIndex;
                      i < startingAccountIndex + additionalEntrants;
                      i++
                  ) {
                      const accountConnectedLottery = lottery.connect(accounts[i])
                      await accountConnectedLottery.enterRaffle({ value: lotteryEntranceFee })
                  }

                  const startingTimeStamp = await lottery.getLatestTimeStamp()

                  await new Promise(async (resolve, reject) => {
                      lottery.once("WinnerPicked", async () => {
                          console.log("Event fired")
                          try {
                              const recentWinner = await lottery.getRecentWinner()
                              const lotteryState = await lottery.getLotteryState()
                              const endingTimeStamp = await lottery.getLatestTimeStamp()
                              const numPlayers = await lottery.getNumberOfPlayers()
                              const winnerEndingBalance = await accounts[1].getBalance()
                              console.log(recentWinner)
                              assert.equal(numPlayers.toString(), "0")
                              assert.equal(lotteryState.toString(), "0")
                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance
                                      .add(lotteryEntranceFee.mul(additionalEntrants + 1))
                                      .toString()
                              )
                              assert(endingTimeStamp > startingTimeStamp)
                          } catch (e) {
                              reject(e)
                          }
                          resolve()
                      })
                      const tx = await lottery.performUpkeep([])
                      const txReceipt = await tx.wait(1)
                      const winnerStartingBalance = await accounts[1].getBalance() //Mock always picks account 1
                      await vrfCoordinatorV2Mock.fulfillRandomWords(
                          txReceipt.events[1].args.requestId,
                          lottery.address
                      )
                  })
              })
          })
      })
