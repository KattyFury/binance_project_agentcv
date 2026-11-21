// Local deploy page: you sign the deploy transactions in your own browser wallet, no private key in this repo.
// Usage: npx hardhat compile && node scripts/deploy-web.js   then open http://localhost:8787
const fs = require("fs");
const path = require("path");
const http = require("http");

const root = path.join(__dirname, "..");
const web = path.join(root, "deploy-web");
const art = (n) => require(path.join(root, "artifacts/contracts", `${n}.sol`, `${n}.json`));
const names = ["ReportRegistry", "PredictArena", "ReputationHub", "ReputationGate"];
const contracts = Object.fromEntries(names.map((n) => [n, { abi: art(n).abi, bytecode: art(n).bytecode }]));
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("="))
);
const config = { feeds: [env.FEED_BTC, env.FEED_ETH, env.FEED_BNB], agentId: env.AGENT_ID || "0x60b9262456de011f7d15a54cdd8c48baaa8b022f" };

const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/save") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        const out = JSON.parse(body);
        fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
        const file = path.join(root, "deployments", `${out.network}.json`);
        fs.writeFileSync(file, JSON.stringify(out, null, 2));
        console.log("Saved", file);
        res.end("saved deployments/" + out.network + ".json");
      });
    }
    if (req.url === "/contracts.json") return res.end(JSON.stringify({ contracts, config }));
    if (req.url === "/ethers.js") return res.end(fs.readFileSync(path.join(root, "node_modules/ethers/dist/ethers.umd.min.js")));
    const f = path.join(web, req.url === "/" ? "index.html" : path.basename(req.url));
    if (!fs.existsSync(f)) return (res.statusCode = 404), res.end();
    res.setHeader("content-type", types[path.extname(f)] || "text/plain");
    res.end(fs.readFileSync(f));
  })
  .listen(8787, "127.0.0.1", () => console.log("Deploy page: http://localhost:8787"));
