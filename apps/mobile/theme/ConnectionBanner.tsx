import { StyleSheet, Text, View } from "react-native";
import { colors, fonts, spacing } from "./theme";

/** Shown at the top of every screen — read-only means the user needs to know at a glance whether what they're looking at is live. */
export function ConnectionBanner({ connected, lastError }: { connected: boolean; lastError: string | null }) {
  if (connected) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.text}>{lastError ? `Disconnected — ${lastError}` : "Connecting…"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  text: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
});
