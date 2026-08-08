import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts, spacing } from "../theme/theme";
import { DEFAULT_HOST, setServerHost } from "../lib/settings";
import type { HandsStreamState } from "../lib/useHandsStream";
import { QrScanner } from "./QrScanner";

/**
 * Where "hands serve" is running. Pairing (hands#110) is the happy path — "Scan QR" against
 * `hands serve --lan`'s printed code — but the manual text field STAYS as the fallback for no
 * camera, a stale QR, or a simulator (which reaches `localhost` directly and never needs pairing
 * at all). Originally (hands#107) this was the field alone; a physical device needing the dev
 * machine's LAN IP is exactly the friction pairing removes.
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
  const [scanning, setScanning] = useState(false);

  useEffect(() => setDraft(host), [host]);

  const save = async (value: string) => {
    const next = value.trim() || DEFAULT_HOST;
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
          IP instead — scan the QR code `hands serve --lan` prints, or type it below (e.g.
          "192.168.1.42:4319"); localhost on a phone means the phone itself.
        </Text>
        <Pressable style={styles.button} onPress={() => setScanning(true)}>
          <Text style={styles.buttonText}>Scan QR</Text>
        </Pressable>
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
        <Pressable style={styles.secondaryButton} onPress={() => void save(draft)}>
          <Text style={styles.secondaryButtonText}>Save & reconnect</Text>
        </Pressable>

        <View style={styles.statusBlock}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.hint}>
            {stream.connected ? "Connected" : stream.lastError ? `Disconnected — ${stream.lastError}` : "Connecting…"}
          </Text>
        </View>
      </View>

      <QrScanner
        visible={scanning}
        onCancel={() => setScanning(false)}
        onScanned={(scannedHost) => {
          setScanning(false);
          void save(scannedHost);
        }}
      />
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
    marginBottom: spacing.md,
  },
  buttonText: { color: colors.ink, fontFamily: fonts.uiMedium, fontSize: 15 },
  secondaryButton: { alignItems: "center", paddingVertical: spacing.sm },
  secondaryButtonText: { color: colors.muted, fontFamily: fonts.ui, fontSize: 13 },
  statusBlock: { marginTop: spacing.xl },
});
