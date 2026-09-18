// Stamp fork identity only in the publish directory, keeping upstream metadata intact.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const revision = execFileSync("git", ["rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
const output = ".dameng-package";
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync("dist", `${output}/dist`, { recursive: true });
cpSync("LICENSE", `${output}/LICENSE`);
cpSync("DAMENG.md", `${output}/README.md`);
cpSync("dbhub.dameng.toml.example", `${output}/dbhub.dameng.toml.example`);
writeFileSync(
  `${output}/package.json`,
  JSON.stringify(
    {
      ...pkg,
      name: "@zz1996/dbhub-dameng",
      version: `${pkg.version.split("-")[0]}-dameng.${revision}`,
      description: "DBHub with a minimal Dameng/DM8 connector",
      repository: { type: "git", url: "git+https://github.com/zuozh11/dbhub-dameng.git" },
      homepage: "https://github.com/zuozh11/dbhub-dameng/blob/main/DAMENG.md",
      bugs: { url: "https://github.com/zuozh11/dbhub-dameng/issues" },
      mcpName: "io.github.zuozh11/dbhub-dameng",
      bin: { "dbhub-dameng": "dist/index.js" },
      files: ["dist", "LICENSE", "README.md", "dbhub.dameng.toml.example"],
      scripts: {},
      devDependencies: undefined,
      packageManager: undefined,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    },
    null,
    2
  ) + "\n"
);
console.log(`Prepared @zz1996/dbhub-dameng@${pkg.version.split("-")[0]}-dameng.${revision}`);
