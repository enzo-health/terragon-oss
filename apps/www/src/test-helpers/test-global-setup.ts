import {
  setup as setupShared,
  teardown as teardownShared,
} from "@leo/shared/test-global-setup";

export async function setup() {
  await setupShared();
}

export async function teardown() {
  await teardownShared();
}
