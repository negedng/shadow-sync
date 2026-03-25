import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, readShadowFile } from "./harness";
import { assertEqual } from "./assert";

/** Test: push syncs deeply nested directory structures to shadow branch. */
export default function run() {
  const env = createTestEnv("push-deep-dirs");
  try {
    // Initial sync
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add deeply nested files locally
    commitOnLocal(env, {
      "src/components/Button.tsx": "export const Button = () => {};\n",
      "src/utils/helpers/format.ts": "export function format() {}\n",
    }, "Add nested files");

    const r2 = runPush(env, "Push nested structure");
    assertEqual(r2.status, 0, "push should succeed");

    assertEqual(
      readShadowFile(env, "src/components/Button.tsx"),
      "export const Button = () => {};\n",
      "nested tsx file on shadow branch",
    );
    assertEqual(
      readShadowFile(env, "src/utils/helpers/format.ts"),
      "export function format() {}\n",
      "triple nested file on shadow branch",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-deep-dirs");
}
