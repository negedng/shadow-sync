import { createTestEnv, commitOnRemote, runCiSync, readShadowFile } from "./harness";
import { assertEqual } from "./assert";

/** Test: pull syncs files in deeply nested directory structures. */
export default function run() {
  const env = createTestEnv("pull-deep-dirs");
  try {
    commitOnRemote(env, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
      "docs/api/v1/README.md": "# API v1\n",
    }, "Add deeply nested files");

    const r = runCiSync(env);
    assertEqual(r.status, 0, "pull should succeed");

    assertEqual(
      readShadowFile(env, "src/components/Button.tsx"),
      "export const Button = () => {};\n",
      "deeply nested tsx file",
    );
    assertEqual(
      readShadowFile(env, "src/utils/helpers/format.ts"),
      "export function format() {}\n",
      "triple nested ts file",
    );
    assertEqual(
      readShadowFile(env, "docs/api/v1/README.md"),
      "# API v1\n",
      "docs nested file",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-deep-dirs");
}
