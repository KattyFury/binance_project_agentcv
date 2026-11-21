const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const HOUR = 3600;

async function deploy(minRounds = 2) {
  const [owner, a1, a2, a3, a4, nobody, relayer] = await ethers.getSigners();
  const agentId = await (await ethers.getContractFactory("MockAgentId")).deploy();
  for (const s of [a1, a2, a3, a4]) await agentId.mint(s.address);
  const reg = await (await ethers.getContractFactory("ReportRegistry")).deploy(await agentId.getAddress());
  const Feed = await ethers.getContractFactory("MockFeed");
  const feeds = [await Feed.deploy(), await Feed.deploy(), await Feed.deploy()];
  const now = await time.latest();
  const genesis = Math.floor(now / HOUR) * HOUR - 10 * HOUR; // currentHour() == 10
  const arena = await (
    await ethers.getContractFactory("PredictArena")
  ).deploy(
    await agentId.getAddress(),
    await reg.getAddress(),
    await Promise.all(feeds.map((f) => f.getAddress())),
    genesis,
    minRounds
  );
  const hub = await (await ethers.getContractFactory("ReputationHub")).deploy(
    await arena.getAddress(),
    await reg.getAddress()
  );
  return { owner, a1, a2, a3, a4, nobody, relayer, agentId, reg, feeds, arena, hub, genesis };
}

const ts = (g, h) => g + h * HOUR;
const item = (horizon, startHour, asset, pBps, reportId = 0, note = "") => ({
  horizon, startHour, asset, pBps, reportId, note,
});

// Move to hour h (+60s) and record prices for BTC/ETH/BNB with fresh feeds.
async function recordAt(c, h, btc, eth = 2000, bnb = 600, updatedAgo = 5) {
  const t = ts(c.genesis, h) + 60;
  await time.increaseTo(t);
  await c.feeds[0].set(btc, t - updatedAgo);
  await c.feeds[1].set(eth, t - updatedAgo);
  await c.feeds[2].set(bnb, t - updatedAgo);
  await c.arena.recordPrices(h);
}

describe("PredictArena - entries", () => {
  it("accepts a valid H1 prediction and emits Predicted", async () => {
    const c = await loadFixture(deploy);
    const s = (await c.arena.currentHour()) + 1n;
    await expect(c.arena.connect(c.a1).predict([item(1, s, 0, 7000, 0, "why")]))
      .to.emit(c.arena, "Predicted")
      .withArgs(c.a1.address, 1, s, 0, 7000, 0, "why");
    expect(await c.arena.predictorCount(1, s, 0)).to.equal(1);
  });

  it("rejects non-holders, duplicates and bad ranges", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    await expect(c.arena.connect(c.nobody).predict([item(1, s, 0, 7000)])).to.be.revertedWith("no Agent ID");
    await c.arena.connect(c.a1).predict([item(1, s, 0, 7000)]);
    await expect(c.arena.connect(c.a1).predict([item(1, s, 0, 6000)])).to.be.revertedWith("already predicted");
    await expect(c.arena.connect(c.a1).predict([item(1, s, 1, 50)])).to.be.revertedWith("pBps out of range");
    await expect(c.arena.connect(c.a1).predict([item(1, s, 1, 10000)])).to.be.revertedWith("pBps out of range");
    await expect(c.arena.connect(c.a1).predict([item(1, s, 3, 5000)])).to.be.revertedWith("bad asset");
    await expect(c.arena.connect(c.a1).predict([item(2, s, 1, 5000)])).to.be.revertedWith("bad horizon");
  });

  it("enforces lock time and the look-ahead limit", async () => {
    const c = await loadFixture(deploy);
    const now = Number(await c.arena.currentHour());
    await expect(c.arena.connect(c.a1).predict([item(1, now, 0, 5000)])).to.be.revertedWith("round locked");
    await expect(c.arena.connect(c.a1).predict([item(1, now + 7, 0, 5000)])).to.be.revertedWith("too far ahead");
    await c.arena.connect(c.a1).predict([item(1, now + 6, 0, 5000)]); // exactly 6 ahead is fine
  });

  it("D1 rounds only start at 00:00 UTC hour boundaries (multiple of 24)", async () => {
    const c = await loadFixture(deploy);
    const now = Number(await c.arena.currentHour());
    const d1 = (Math.floor(now / 24) + 1) * 24;
    await expect(c.arena.connect(c.a1).predict([item(24, d1 + 1, 0, 5000)])).to.be.revertedWith(
      "D1 starts at 00:00 UTC"
    );
    await c.arena.connect(c.a1).predict([item(24, d1, 0, 5000)]);
  });

  it("limits batch size to 18 and rejects empty or oversized notes", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    await expect(c.arena.connect(c.a1).predict([])).to.be.revertedWith("bad batch size");
    const many = [];
    for (let i = 0; i < 19; i++) many.push(item(1, s + (i % 6), i % 3, 5000));
    await expect(c.arena.connect(c.a1).predict(many)).to.be.revertedWith("bad batch size");
    await expect(c.arena.connect(c.a1).predict([item(1, s, 0, 5000, 0, "x".repeat(281))])).to.be.revertedWith(
      "note too long"
    );
    const ok = [];
    for (let h = 0; h < 6; h++) for (let a = 0; a < 3; a++) ok.push(item(1, s + h, a, 5000)); // 18 items
    await c.arena.connect(c.a1).predict(ok);
  });

  it("only allows attaching your own report as evidence", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    const h = ethers.id("report");
    await c.reg.connect(c.a2).publish(h, "ipfs://r1", 0, 0);
    await expect(c.arena.connect(c.a1).predict([item(1, s, 0, 6000, 1)])).to.be.revertedWith("report not yours");
    await c.arena.connect(c.a2).predict([item(1, s, 0, 6000, 1)]);
    const [p, rid] = await c.arena.getPrediction(1, s, 0, c.a2.address);
    expect(p).to.equal(6000);
    expect(rid).to.equal(1);
  });
});

describe("PredictArena - prices and settlement", () => {
  it("records prices only inside the 10 minute window, once", async () => {
    const c = await loadFixture(deploy);
    await expect(c.arena.recordPrices(12)).to.be.revertedWith("outside window"); // future hour
    await recordAt(c, 11, 100);
    await expect(c.arena.recordPrices(11)).to.be.revertedWith("already recorded");
    await time.increaseTo(ts(c.genesis, 12) + 601);
    await expect(c.arena.recordPrices(12)).to.be.revertedWith("outside window"); // too late
  });

  it("scores skill = 0.25 - (p-o)^2 in micro-units (up round)", async () => {
    const c = await loadFixture(deploy);
    const s = 11;
    await c.arena.connect(c.a1).predict([item(1, s, 0, 8000)]);
    await c.arena.connect(c.a2).predict([item(1, s, 0, 2000)]);
    await c.arena.connect(c.a3).predict([item(1, s, 0, 9900)]);
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 110);
    await c.arena.settle(1, s, 0, 10);
    // a1: diff 2000 -> 2000^2/100 = 40000 -> 210000
    expect((await c.arena.getTotals(c.a1.address)).skill).to.equal(210000);
    // a2: diff 8000 -> 640000 -> -390000
    expect((await c.arena.getTotals(c.a2.address)).skill).to.equal(-390000);
    // a3: diff 100 -> 100 -> 249900
    expect((await c.arena.getTotals(c.a3.address)).skill).to.equal(249900);
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(1);
  });

  it("scores a down round", async () => {
    const c = await loadFixture(deploy);
    await c.arena.connect(c.a1).predict([item(1, 11, 1, 3000)]);
    await recordAt(c, 11, 100, 2000);
    await recordAt(c, 12, 100, 1900); // ETH down
    await c.arena.settle(1, 11, 1, 10);
    // o = 0, p = 3000 -> diff 3000 -> 9000000/100 = 90000 -> 160000
    expect((await c.arena.getTotals(c.a1.address)).skill).to.equal(160000);
  });

  it("voids rounds when the price is unchanged, stale, feed down, or never recorded", async () => {
    const c = await loadFixture(deploy);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 9000), item(1, 11, 1, 9000), item(1, 11, 2, 9000)]);
    await c.arena.connect(c.a1).predict([item(1, 12, 0, 9000)]);
    await recordAt(c, 11, 100, 2000, 600);
    // hour 12: BTC unchanged, ETH stale (updated 2h before), BNB feed down
    const t = ts(c.genesis, 12) + 60;
    await time.increaseTo(t);
    await c.feeds[0].set(100, t - 5);
    await c.feeds[1].set(2100, t - 7200);
    await c.feeds[2].setBroken(true);
    await c.arena.recordPrices(12);
    await c.arena.settle(1, 11, 0, 10);
    await c.arena.settle(1, 11, 1, 10);
    await c.arena.settle(1, 11, 2, 10);
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(0);
    // hour 13 never recorded: round 12->13 resolves as void after the window
    await expect(c.arena.settle(1, 12, 0, 10)).to.be.revertedWith("prices pending");
    await time.increaseTo(ts(c.genesis, 13) + 601);
    await expect(c.arena.settle(1, 12, 0, 10)).to.emit(c.arena, "Settled");
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(0);
  });

  it("settles in chunks and never double counts", async () => {
    const c = await loadFixture(deploy);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000)]);
    await c.arena.connect(c.a2).predict([item(1, 11, 0, 8000)]);
    await c.arena.connect(c.a3).predict([item(1, 11, 0, 8000)]);
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 120);
    await c.arena.settle(1, 11, 0, 2);
    expect((await c.arena.getTotals(c.a3.address)).count).to.equal(0);
    await c.arena.settle(1, 11, 0, 2);
    expect((await c.arena.getTotals(c.a3.address)).count).to.equal(1);
    await expect(c.arena.settle(1, 11, 0, 2)).to.be.revertedWith("nothing to settle");
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(1);
  });

  it("splits skill by predictions with and without an attached report", async () => {
    const c = await loadFixture(deploy);
    await c.reg.connect(c.a1).publish(ethers.id("r"), "ipfs://r", 0, 0);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000, 1), item(1, 11, 1, 8000, 0)]);
    await recordAt(c, 11, 100, 2000);
    await recordAt(c, 12, 110, 2100);
    await c.arena.settle(1, 11, 0, 5);
    await c.arena.settle(1, 11, 1, 5);
    const t = await c.arena.getTotals(c.a1.address);
    expect(t.countWith).to.equal(1);
    expect(t.countNo).to.equal(1);
    expect(t.skillWith).to.equal(210000);
    expect(t.skillNo).to.equal(210000);
    expect(t.skill).to.equal(420000);
  });

  it("D1 round compares the price 24 hours apart", async () => {
    const c = await loadFixture(deploy);
    const d1 = 24; // multiple of 24, 14 hours ahead
    await c.arena.connect(c.a1).predict([item(24, d1, 0, 7000)]);
    await recordAt(c, d1, 100);
    await recordAt(c, d1 + 24, 90); // down
    await c.arena.settle(24, d1, 0, 5);
    // o = 0, p = 7000 -> diff 7000 -> 490000 -> -240000
    expect((await c.arena.getTotals(c.a1.address)).skill).to.equal(-240000);
  });
});

describe("PredictArena - weekly leaderboard", () => {
  async function weekFixture() {
    const c = await deploy(2);
    // BTC path hours 11..14: 100, 110, 100, 120 -> rounds: up, down, up
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000), item(1, 12, 0, 3000), item(1, 13, 0, 8000)]);
    await c.arena.connect(c.a2).predict([item(1, 11, 0, 2000), item(1, 12, 0, 7000), item(1, 13, 0, 2000)]);
    await c.arena.connect(c.a3).predict([item(1, 11, 0, 8000), item(1, 12, 0, 3000)]);
    await c.arena.connect(c.a4).predict([item(1, 11, 0, 9000)]); // only 1 round: not eligible (min 2)
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 110);
    await recordAt(c, 13, 100);
    await recordAt(c, 14, 120);
    for (const st of [11, 12, 13]) await c.arena.settle(1, st, 0, 20);
    return c;
  }

  it("ranks by total skill, requires min rounds, and ignores ineligible agents", async () => {
    const c = await weekFixture();
    const top = await c.arena.getWeekTop(0);
    expect(top[0]).to.equal(c.a1.address);
    expect(top[1]).to.equal(c.a3.address);
    expect(top[2]).to.equal(c.a2.address);
    expect(top[3]).to.equal(ethers.ZeroAddress);
    const w4 = await c.arena.getWeekAgent(0, c.a4.address);
    expect(w4.count).to.equal(1); // tracked but not ranked
  });

  it("finalizes only after the week plus 6 hours, and only once", async () => {
    const c = await weekFixture();
    await expect(c.arena.finalizeWeek(0)).to.be.revertedWith("week not over");
    await time.increaseTo(ts(c.genesis, 168) + 6 * HOUR + 1);
    await expect(c.arena.finalizeWeek(0)).to.emit(c.arena, "WeekFinalized");
    expect(await c.arena.weekFinalized(0)).to.equal(true);
    const top = await c.arena.getWeekTop(0);
    expect(top[0]).to.equal(c.a1.address);
    await expect(c.arena.finalizeWeek(0)).to.be.revertedWith("already finalized");
  });

  it("breaks ties by more rounds, then by who reached the score first", async () => {
    const c = await deploy(1);
    // a1: one correct round (BTC). a2: same skill on ETH plus a zero-skill 50% call on BNB (count 2).
    // a3: same skill as a1 but settled last.
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000)]);
    await c.arena.connect(c.a2).predict([item(1, 11, 1, 8000), item(1, 11, 2, 5000)]);
    await c.arena.connect(c.a3).predict([item(1, 11, 2, 8000)]);
    await recordAt(c, 11, 100, 2000, 600);
    await recordAt(c, 12, 110, 2100, 660);
    await c.arena.settle(1, 11, 0, 5); // a1 reaches 210000 first
    await c.arena.settle(1, 11, 1, 5); // a2 reaches 210000 next
    await c.arena.settle(1, 11, 2, 5); // a2 +0 (count 2), a3 reaches 210000 last
    const top = await c.arena.getWeekTop(0);
    expect(top[0]).to.equal(c.a2.address); // equal skill, more rounds
    expect(top[1]).to.equal(c.a1.address); // equal skill and rounds, reached first
    expect(top[2]).to.equal(c.a3.address);
    expect((await c.arena.getWeekAgent(0, c.a2.address)).skill).to.equal(210000);
  });

  it("settling after finalization still updates all-time totals but not the frozen week", async () => {
    const c = await deploy(1);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000)]);
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 110);
    await time.increaseTo(ts(c.genesis, 168) + 6 * HOUR + 1);
    await c.arena.finalizeWeek(0); // a1 not settled yet -> empty top
    await c.arena.settle(1, 11, 0, 5);
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(1);
    expect((await c.arena.getWeekAgent(0, c.a1.address)).count).to.equal(0);
    expect((await c.arena.getWeekTop(0))[0]).to.equal(ethers.ZeroAddress);
  });
});

describe("PredictArena - EIP-712 relayed predictions", () => {
  const types = {
    Item: [
      { name: "horizon", type: "uint8" },
      { name: "startHour", type: "uint32" },
      { name: "asset", type: "uint8" },
      { name: "pBps", type: "uint16" },
      { name: "reportId", type: "uint64" },
      { name: "note", type: "string" },
    ],
    PredictBatch: [
      { name: "agent", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "items", type: "Item[]" },
    ],
  };

  async function sign(c, signer, agent, items, deadline) {
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "AgentReputationHub",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await c.arena.getAddress(),
    };
    const nonce = await c.arena.nonces(agent);
    return signer.signTypedData(domain, types, { agent, nonce, deadline, items });
  }

  it("lets a relayer submit a signed batch for an Agent ID holder", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    const items = [item(1, s, 0, 6500, 0, "btc up"), item(1, s, 1, 4000, 0, "eth down")];
    const deadline = (await time.latest()) + 600;
    const sig = await sign(c, c.a1, c.a1.address, items, deadline);
    await expect(c.arena.connect(c.relayer).predictBySig(c.a1.address, items, deadline, sig)).to.emit(
      c.arena,
      "Predicted"
    );
    expect((await c.arena.getPrediction(1, s, 0, c.a1.address))[0]).to.equal(6500);
    expect(await c.arena.nonces(c.a1.address)).to.equal(1);
  });

  it("rejects replays, expired batches, wrong signers and non-holders", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    const items = [item(1, s, 0, 6500)];
    const deadline = (await time.latest()) + 600;
    const sig = await sign(c, c.a1, c.a1.address, items, deadline);
    await c.arena.connect(c.relayer).predictBySig(c.a1.address, items, deadline, sig);
    await expect(c.arena.connect(c.relayer).predictBySig(c.a1.address, items, deadline, sig)).to.be.revertedWith(
      "bad sig"
    ); // replay (nonce moved on)

    const items2 = [item(1, s, 1, 6500)];
    const expired = (await time.latest()) - 1;
    const sig2 = await sign(c, c.a1, c.a1.address, items2, expired);
    await expect(c.arena.connect(c.relayer).predictBySig(c.a1.address, items2, expired, sig2)).to.be.revertedWith(
      "expired"
    );

    // a2's signature cannot speak for a1
    const dl = (await time.latest()) + 600;
    const bad = await sign(c, c.a2, c.a1.address, items2, dl);
    await expect(c.arena.connect(c.relayer).predictBySig(c.a1.address, items2, dl, bad)).to.be.revertedWith("bad sig");

    // a signer without an Agent ID
    const sigN = await sign(c, c.nobody, c.nobody.address, items2, dl);
    await expect(c.arena.connect(c.relayer).predictBySig(c.nobody.address, items2, dl, sigN)).to.be.revertedWith(
      "no Agent ID"
    );
  });

  it("rejects a tampered batch (items changed after signing)", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    const dl = (await time.latest()) + 600;
    const sig = await sign(c, c.a1, c.a1.address, [item(1, s, 0, 6500)], dl);
    await expect(
      c.arena.connect(c.relayer).predictBySig(c.a1.address, [item(1, s, 0, 9900)], dl, sig)
    ).to.be.revertedWith("bad sig");
  });
});

describe("PredictArena - owner powers", () => {
  it("owner can pause new predictions but not settlement; others cannot pause", async () => {
    const c = await loadFixture(deploy);
    const s = Number(await c.arena.currentHour()) + 1;
    await c.arena.connect(c.a1).predict([item(1, s, 0, 5000)]);
    await expect(c.arena.connect(c.a1).pause()).to.be.revertedWithCustomError(c.arena, "OwnableUnauthorizedAccount");
    await c.arena.pause();
    await expect(c.arena.connect(c.a2).predict([item(1, s, 0, 5000)])).to.be.revertedWithCustomError(
      c.arena,
      "EnforcedPause"
    );
    await recordAt(c, s, 100); // recording still works while paused
    await recordAt(c, s + 1, 110);
    await c.arena.settle(1, s, 0, 5); // settlement still works while paused
    expect((await c.arena.getTotals(c.a1.address)).count).to.equal(1);
  });

  it("feeds can be replaced only in the first 24 hours", async () => {
    const c = await loadFixture(deploy);
    await c.arena.setFeed(0, c.a1.address);
    await time.increase(24 * HOUR + 5);
    await expect(c.arena.setFeed(0, c.a2.address)).to.be.revertedWith("feeds locked");
  });
});

describe("ReportRegistry", () => {
  it("publishes with version chain, daily limit and Agent ID gating", async () => {
    const c = await loadFixture(deploy);
    await expect(c.reg.connect(c.nobody).publish(ethers.id("x"), "ipfs://x", 0, 0)).to.be.revertedWith("no Agent ID");
    await c.reg.connect(c.a1).publish(ethers.id("v1"), "ipfs://v1", 0, 0);
    await c.reg.connect(c.a1).publish(ethers.id("v2"), "ipfs://v2", 0, 1); // v2 of report 1
    await c.reg.connect(c.a1).publish(ethers.id("v3"), "ipfs://v3", 255, 2);
    await expect(c.reg.connect(c.a1).publish(ethers.id("v4"), "ipfs://v4", 0, 0)).to.be.revertedWith("daily limit");
    await expect(c.reg.connect(c.a2).publish(ethers.id("z"), "ipfs://z", 0, 1)).to.be.revertedWith("prev not yours");
    await time.increase(24 * HOUR + 10);
    await c.reg.connect(c.a1).publish(ethers.id("v4"), "ipfs://v4", 0, 0);
    expect((await c.reg.getReport(2)).prevVersionId).to.equal(1);
    expect(await c.reg.reportCountOf(c.a1.address)).to.equal(4);
  });

  it("validates inputs", async () => {
    const c = await loadFixture(deploy);
    await expect(c.reg.connect(c.a1).publish(ethers.ZeroHash, "ipfs://x", 0, 0)).to.be.revertedWith("empty hash");
    await expect(c.reg.connect(c.a1).publish(ethers.id("x"), "", 0, 0)).to.be.revertedWith("bad uri");
    await expect(c.reg.connect(c.a1).publish(ethers.id("x"), "u".repeat(201), 0, 0)).to.be.revertedWith("bad uri");
    await expect(c.reg.connect(c.a1).publish(ethers.id("x"), "ipfs://x", 7, 0)).to.be.revertedWith("bad asset");
  });

  it("reviews: one per reviewer, not own report, 1-5 stars, Agent ID required", async () => {
    const c = await loadFixture(deploy);
    await c.reg.connect(c.a1).publish(ethers.id("r"), "ipfs://r", 0, 0);
    await expect(c.reg.connect(c.a1).review(1, 5)).to.be.revertedWith("own report");
    await expect(c.reg.connect(c.nobody).review(1, 5)).to.be.revertedWith("no Agent ID");
    await expect(c.reg.connect(c.a2).review(1, 0)).to.be.revertedWith("stars 1-5");
    await expect(c.reg.connect(c.a2).review(1, 6)).to.be.revertedWith("stars 1-5");
    await expect(c.reg.connect(c.a2).review(9, 5)).to.be.revertedWith("no report");
    await c.reg.connect(c.a2).review(1, 5);
    await expect(c.reg.connect(c.a2).review(1, 4)).to.be.revertedWith("already reviewed");
  });

  it("computes research points: (avg stars - 2.5) x min(reviews,10), floored at 0", async () => {
    const c = await loadFixture(deploy);
    await c.reg.connect(c.a1).publish(ethers.id("r"), "ipfs://r", 0, 0);
    await c.reg.connect(c.a2).review(1, 5);
    await c.reg.connect(c.a3).review(1, 5);
    await c.reg.connect(c.a4).review(1, 4);
    // starSum 14, 3 reviews -> avg 4666 milli -> (4666-2500)*3 = 6498
    expect(await c.reg.researchPointsMilliOf(c.a1.address)).to.equal(6498);
    // a poorly rated report cannot push points below zero
    await c.reg.connect(c.a2).publish(ethers.id("bad"), "ipfs://bad", 0, 0);
    await c.reg.connect(c.a1).review(2, 1);
    await c.reg.connect(c.a3).review(2, 1);
    expect(await c.reg.researchPointsMilliOf(c.a2.address)).to.equal(0);
  });

  it("supports EIP-712 relayed publish and review", async () => {
    const c = await loadFixture(deploy);
    const net = await ethers.provider.getNetwork();
    const domain = {
      name: "AgentReputationHub",
      version: "1",
      chainId: net.chainId,
      verifyingContract: await c.reg.getAddress(),
    };
    const dl = (await time.latest()) + 600;
    const pubTypes = {
      Publish: [
        { name: "author", type: "address" },
        { name: "contentHash", type: "bytes32" },
        { name: "uri", type: "string" },
        { name: "assetTag", type: "uint8" },
        { name: "prevVersionId", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    };
    const hash = ethers.id("signed");
    const sig = await c.a1.signTypedData(domain, pubTypes, {
      author: c.a1.address, contentHash: hash, uri: "ipfs://signed", assetTag: 1, prevVersionId: 0, nonce: 0, deadline: dl,
    });
    await c.reg.connect(c.relayer).publishBySig(c.a1.address, hash, "ipfs://signed", 1, 0, dl, sig);
    expect((await c.reg.getReport(1)).author).to.equal(c.a1.address);

    const revTypes = {
      Review: [
        { name: "reviewer", type: "address" },
        { name: "reportId", type: "uint64" },
        { name: "stars", type: "uint8" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    };
    const rsig = await c.a2.signTypedData(domain, revTypes, {
      reviewer: c.a2.address, reportId: 1, stars: 4, nonce: 0, deadline: dl,
    });
    await c.reg.connect(c.relayer).reviewBySig(c.a2.address, 1, 4, dl, rsig);
    expect((await c.reg.getReport(1)).reviewCount).to.equal(1);
    await expect(c.reg.connect(c.relayer).reviewBySig(c.a2.address, 1, 4, dl, rsig)).to.be.revertedWith("bad sig");
  });
});

describe("ReputationHub and ReputationGate", () => {
  it("aggregates predictions, research and toolkit into one reputation view", async () => {
    const c = await loadFixture(deploy);
    await c.reg.connect(c.a1).publish(ethers.id("r"), "ipfs://r", 0, 0);
    await c.reg.connect(c.a2).review(1, 5);
    await c.arena.connect(c.a1).declareToolkit(0b0101);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000, 1)]);
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 110);
    await c.arena.settle(1, 11, 0, 5);
    const r = await c.hub.getReputation(c.a1.address);
    expect(r.predSkillAll).to.equal(210000);
    expect(r.predCountAll).to.equal(1);
    expect(r.predSkill7d).to.equal(210000);
    expect(r.predCountWithReport).to.equal(1);
    expect(r.reportsCount).to.equal(1);
    expect(r.reviewsCount).to.equal(1);
    expect(r.avgStarsBps).to.equal(5000);
    expect(r.researchPointsMilli).to.equal(2500); // (5-2.5)*1
    expect(r.totalMicro).to.equal(210000 + 2500 * 1000);
    expect(r.toolkit).to.equal(5);
    expect(await c.hub.meetsMinScore(c.a1.address, 2_000_000)).to.equal(true);
    expect(await c.hub.meetsMinScore(c.a2.address, 1)).to.equal(false);
  });

  it("the sample gate admits only agents above the reputation threshold", async () => {
    const c = await loadFixture(deploy);
    const gate = await (await ethers.getContractFactory("ReputationGate")).deploy(await c.hub.getAddress(), 200000);
    await c.arena.connect(c.a1).predict([item(1, 11, 0, 8000)]);
    await recordAt(c, 11, 100);
    await recordAt(c, 12, 110);
    await c.arena.settle(1, 11, 0, 5);
    await expect(gate.connect(c.a2).enter()).to.be.revertedWith("reputation too low");
    await expect(gate.connect(c.a1).enter()).to.emit(gate, "Entered").withArgs(c.a1.address);
    await expect(gate.connect(c.a1).enter()).to.be.revertedWith("already entered");
    expect(await gate.enteredCount()).to.equal(1);
  });
});
