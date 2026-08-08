import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts, spacing } from "../theme/theme";
import { DEFAULT_HOST, setServerHost } from "../lib/settings";
import type { HandsStreamState } from "../lib/useHandsStream";

/**
 * The one setting this walking skeleton has: where "hands serve" is running
 * (hands#107). localhost works in a simulator; a physical device needs the
 * dev machine's LAN IP instead, and that's not something to auto-discover —
 * a plain text field the user types their own machine's address into.
 */
export function SettingsScreen({
  host,
  onHostChange,
  stream,
}: {
  host: string;
  onHostChange: (host: string) => void;
  stream: HandsStreamState;
}) {
  const [draft, setDraft] = useState(host);

  useEffect(() => setDraft(host), [host]);

  const save = async () => {
    const next = draft.trim() || DEFAULT_HOST;
    setDraft(next);
    await setServerHost(next);
    onHostChange(next);
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.content}>
        <Text style={styles.label}>Server host</Text>
        <Text style={styles.hint}>
          Simulator on this machine: "{DEFAULT_HOST}". A physical phone needs your computer's LAN
          IP instead, e.g. "192.168.1.42:4319" — localhost on a phone means the phone itself.
        </Text>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={DEFAULT_HOST}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable style={styles.button} onPress={() => void save()}>
          <Text style={styles.buttonText}>Save & reconnect</Text>
        </Pressable>

        <View style={styles.statusBlock}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.hint}>
            {stream.connected ? "Connected" : stream.lastError ? `Disconnected — ${stream.lastError}` : "Connecting…"}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  content: { padding: spacing.lg },
  label: {
    color: colors.paper,
    fontFamily: fonts.uiMedium,
    fontSize: 15,
    marginBottom: spacing.xs,
  },
  hint: {
    color: colors.muted,
    fontFamily: fonts.ui,
    fontSize: 13,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.paper,
    fontFamily: fonts.mono,
    fontSize: 15,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  buttonText: { color: colors.ink, fontFamily: fonts.uiMedium, fontSize: 15 },
  statusBlock: { marginTop: spacing.xl },
});
