import PartySocket from "partysocket";

const usageCountByChannel: Record<string, number> = {};
const partykitByChannel: Record<string, PartySocket> = {};

export function getOrCreateRealtimePartySocket(params: {
  channel: string;
  createSocket: () => PartySocket;
}): PartySocket {
  if (!partykitByChannel[params.channel]) {
    partykitByChannel[params.channel] = params.createSocket();
  }
  return partykitByChannel[params.channel]!;
}

export function disconnectRealtimePartySocket(channel: string): void {
  const socket = partykitByChannel[channel];
  if (socket) {
    socket.close();
    delete partykitByChannel[channel];
  }
}

export function incrementRealtimeChannelUsage(channel: string): void {
  usageCountByChannel[channel] = (usageCountByChannel[channel] || 0) + 1;
}

export function decrementRealtimeChannelUsage(channel: string): number {
  usageCountByChannel[channel] = (usageCountByChannel[channel] || 0) - 1;
  return usageCountByChannel[channel] || 0;
}

export function resetRealtimeStateForTests(): void {
  for (const channel of Object.keys(partykitByChannel)) {
    disconnectRealtimePartySocket(channel);
  }
  for (const channel of Object.keys(usageCountByChannel)) {
    delete usageCountByChannel[channel];
  }
}
