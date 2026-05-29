export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerPatchVersionProvider } = await import(
      "@terragon/shared/broadcast-server"
    );

    const { redis } = await import("./lib/redis");
    registerPatchVersionProvider(async (threadChatId: string) => {
      return redis.incr(`pv:${threadChatId}`);
    });
  }
}
