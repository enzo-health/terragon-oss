import React from "react";
import { Box, Text } from "ink";
import { useQuery } from "@tanstack/react-query";
import updateNotifier from "update-notifier";
import packageJson from "../../package.json" assert { type: "json" };

async function checkForUpdate() {
  // Check if update notifications are disabled
  if (process.env.TERRY_NO_UPDATE_CHECK === "1") {
    return null;
  }

  const notifier = updateNotifier({
    pkg: packageJson,
    updateCheckInterval: 1000 * 60 * 60, // 1 hour
  });

  const info = await notifier.fetchInfo();

  if (info.latest !== info.current) {
    return {
      current: info.current,
      latest: info.latest,
    };
  }

  return null;
}

export function UpdateNotifier() {
  const { data: updateInfo } = useQuery({
    queryKey: ["update-check"],
    queryFn: checkForUpdate,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: false, // Don't retry update checks
  });

  if (!updateInfo) {
    return null;
  }

  return (
    <Box marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        Update available: {updateInfo.current} → {updateInfo.latest}
      </Text>
      <Text color="gray"> Run </Text>
      <Text color="cyan">npm install -g @leo-labs/cli</Text>
      <Text color="gray"> to update</Text>
    </Box>
  );
}
