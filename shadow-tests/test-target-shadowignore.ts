// Target-side .shadowignore (the union half of the source/target ignore rule).
// On --from b (import) the engine reads the TARGET's .shadowignore from the base
// tree it builds on and unions it with the source patterns: a path is dropped if
// EITHER side ignores it. The pattern lives at the mono ROOT, so it's written in
// TARGET space — the b-side root maps under frontend/, hence the frontend/ prefix.
//
// It's amended into the INIT commit on purpose: a source root anchors to the
// target's init commit (resolveHaltAwareParents), so the shadow branch is rooted
// there and every parentTree carries the init's .shadowignore. This mirrors the
// real "amend .shadowignore into the monorepo init" workflow.
import { execSync } from "child_process";
import * as fs from "fs";
import { createTestEnv, setTestBranchAllowlist, commitOnRemote, runCiSync, readShadowFile } from "./harness";
import { assertEqual } from "./assert";

const env = createTestEnv("target-shadowignore", "frontend");
setTestBranchAllowlist({ team: ["main"], origin: ["main"] });

const g = (c: string) => execSync(`git ${c}`, { cwd: env.localRepo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

// Amend the mono INIT commit (currently HEAD) to carry the target .shadowignore.
fs.writeFileSync(`${env.localRepo}/.shadowignore`, "frontend/skip-me/\n");
g("add .shadowignore");
g("commit --amend --no-edit");
g(`push -f origin ${env.mainBranch}`);

// External dev adds a kept file and a file under the ignored path in one commit.
commitOnRemote(env, {
  "keep.txt": "keep me\n",
  "skip-me/secret.txt": "1.2GB blob stand-in\n",
}, "add keep + skip-me");

const r = runCiSync(env);
assertEqual(r.status, 0, "import --from b should succeed");

assertEqual(readShadowFile(env, "keep.txt"), "keep me\n",
  "non-ignored file syncs to the shadow branch");
assertEqual(readShadowFile(env, "skip-me/secret.txt"), null,
  "target-side .shadowignore drops the incoming ignored-path file on import");

env.cleanup();
console.log("PASS — target .shadowignore drops incoming paths on --from b (union with source).");
