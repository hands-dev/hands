import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts, spacing } from "../theme/theme";
import { parsePairingPayload } from "../lib/pairing";

/**
 * QR pairing (hands#110) — a full-screen scanner Modal, opened from Settings. Pairing is the
 * happy path, not the only one: the manual host field stays and is the fallback for no camera
 * permission, a stale/misprinted QR, or scanning something that isn't a hands pairing code at all.
 */
export function QrScanner({
  visible,
  onCancel,
  onScanned,
}: {
  visible: boolean;
  onCancel: () => void;
  onScanned: (host: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  // CameraView fires onBarcodeScanned repeatedly while a code stays in frame — this ref, not
  // state, gates it so only the FIRST scan of a visible session is processed; state would still
  // let a second frame slip through before the re-render that flips it lands.
  const handledRef = useRef(false);

  if (!visible) return null;

  const reset = () => {
    handledRef.current = false;
    setError(null);
  };

  const close = () => {
    reset();
    onCancel();
  };

  const handleScan = (data: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const host = parsePairingPayload(data);
    if (!host) {
      setError("That QR code isn't a hands pairing code — scan the one from `hands serve --lan`.");
      // Allow another attempt without dismissing — a mis-scan should fail visibly, not silently,
      // and shouldn't force the user to reopen the scanner to try again.
      setTimeout(() => {
        handledRef.current = false;
      }, 1500);
      return;
    }
    reset();
    onScanned(host);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        {!permission ? (
          <View style={styles.center}>
            <Text style={styles.hint}>Checking camera permission…</Text>
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={styles.label}>Camera access needed</Text>
            <Text style={styles.hint}>
              {permission.canAskAgain
                ? "hands needs the camera to scan a pairing QR code. Nothing is recorded or uploaded."
                : "Camera access was denied. Enable it for hands in your phone's Settings app, or " +
                  "use the host field below instead."}
            </Text>
            {permission.canAskAgain ? (
              <Pressable style={styles.button} onPress={() => void requestPermission()}>
                <Text style={styles.buttonText}>Grant permission</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.secondaryButton} onPress={close}>
              <Text style={styles.secondaryButtonText}>Use the host field instead</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(result) => handleScan(result.data)}
            />
            <View style={styles.overlay} pointerEvents="box-none">
              <Text style={styles.overlayHint}>
                Point the camera at the QR code shown by `hands serve --lan`
              </Text>
              {error ? <Text style={styles.overlayError}>{error}</Text> : null}
              <Pressable style={styles.cancelButton} onPress={close}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  center: { flex: 1, justifyContent: "center", padding: spacing.lg },
  label: {
    color: colors.paper,
    fontFamily: fonts.uiMedium,
    fontSize: 16,
    marginBottom: spacing.xs,
  },
  hint: {
    color: colors.muted,
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: spacing.lg,
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
  overlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.lg,
    backgroundColor: "rgba(11,11,12,0.75)",
  },
  overlayHint: {
    color: colors.paper,
    fontFamily: fonts.ui,
    fontSize: 13,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  overlayError: {
    color: colors.accent,
    fontFamily: fonts.uiMedium,
    fontSize: 13,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  cancelButton: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  cancelButtonText: { color: colors.paper, fontFamily: fonts.uiMedium, fontSize: 15 },
});
