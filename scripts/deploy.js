// Usage: FEED_BTC=0x.. FEED_ETH=0x.. FEED_BNB=0x.. DEPLOYER_KEY=0x.. npx hardhat run scripts/deploy.js --network bscTestnet
// Optional env: AGENT_ID, GENESIS (default 2026-11-30 00:00 UTC), MIN_ROUNDS (default 10), GATE_MIN_MICRO (default 200000)
const fs = require("fs");
const { ethers, network } = require("hardhat");

async function main() {
  const AGENT_ID = process.env.AGENT_ID || "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
  const feeds = [process.env.FEED_BTC, process.env.FEED_ETH, process.env.FEED_BNB];
  if (feeds.some((f) => !f)) throw new Error("Set FEED_BTC, FEED_ETH, FEED_BNB (Chainlink feed addresses, verify them first)");
  const GENESIS = Number(process.env.GENESIS || 1795996800);
  const MIN_ROUNDS = Number(process.env.MIN_ROUNDS || 10);
  const GATE_MIN = BigInt(process.env.GATE_MIN_MICRO || 200000);
  if (GENESIS % 3600 !== 0) throw new Error("GENESIS must be hour-aligned");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address, "network:", network.name);

  const reg = await (await ethers.getContractFactory("ReportRegistry")).deploy(AGENT_ID);
  await reg.waitForDeployment();
  const arena = await (
    await ethers.getContractFactory("PredictArena")
  ).deploy(AGENT_ID, await reg.getAddress(), feeds, GENESIS, MIN_ROUNDS);
  await arena.waitForDeployment();
  const hub = await (await ethers.getContractFactory("ReputationHub")).deploy(
    await arena.getAddress(),
    await reg.getAddress()
  );
  await hub.waitForDeployment();
  const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(await hub.getAddress(), GATE_MIN);
  await gate.waitForDeployment();

  const out = {
    network: network.name,
    agentId: AGENT_ID,
    genesis: GENESIS,
    minRounds: MIN_ROUNDS,
    feeds,
    ReportRegistry: await reg.getAddress(),
    PredictArena: await arena.getAddress(),
    ReputationHub: await hub.getAddress(),
    ReputationGate: await gate.getAddress(),
    constructorArgs: {
      ReportRegistry: [AGENT_ID],
      PredictArena: [AGENT_ID, await reg.getAddress(), feeds, GENESIS, MIN_ROUNDS],
      ReputationHub: [await arena.getAddress(), await reg.getAddress()],
      ReputationGate: [await hub.getAddress(), GATE_MIN.toString()],
    },
  };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2));
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
