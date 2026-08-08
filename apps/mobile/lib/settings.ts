import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The server host is configurable in-app, not hardcoded — a simulator on
 * this machine reaches `localhost` fine, but a physical phone cannot: it
 * needs the dev machine's LAN IP, and that changes network to network
 * (hands#107). `localhost:4319` (hands serve's default port) is the
 * default so the simulator path works with zero setup; a real device needs
 * this changed once in Settings.
 */
const HOST_KEY = "hands.serverHost";
export const DEFAULT_HOST = "localhost:4319";

export async function getServerHost(): Promise<string> {
  const stored = await AsyncStorage.getItem(HOST_KEY);
  return stored && stored.trim() ? stored.trim() : DEFAULT_HOST;
}

export async function setServerHost(host: string): Promise<void> {
  const trimmed = host.trim();
  if (trimmed) await AsyncStorage.setItem(HOST_KEY, trimmed);
  else await AsyncStorage.removeItem(HOST_KEY);
}

export function eventsUrl(host: string): string {
  return `http://${host}/api/events`;
}
