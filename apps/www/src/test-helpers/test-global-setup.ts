import {
  setup as setupShared,
  teardown as teardownShared,
} from "@terragon/shared/test-global-setup";

export async function setup() {
  // Allow skipping test container setup when using external services
  // This is used by `delivery-loop:local test-streams` to run against real Redis
  if (process.env.SKIP_TEST_GLOBAL_SETUP === "true") {
    console.log("Skipping test-global-setup (SKIP_TEST_GLOBAL_SETUP=true)");
    return;
  }
  await setupShared();
}

export async function teardown() {
  if (process.env.SKIP_TEST_GLOBAL_SETUP === "true") {
    return;
  }
  await teardownShared();
}
