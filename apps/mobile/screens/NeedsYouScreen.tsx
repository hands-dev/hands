import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionBanner } from "../theme/ConnectionBanner";
import { colors, fonts, spacing } from "../theme/theme";
import type { HandsStreamState } from "../lib/useHandsStream";
import type { MobileQuestion } from "../types/hands-snapshot";

function QuestionRow({ question }: { question: MobileQuestion }) {
  return (
    <View style={styles.row}>
      <Text style={styles.question}>{question.question}</Text>
      <Text style={styles.meta}>
        asked by {question.asker}
        {question.priority ? ` · ${question.priority}` : ""}
      </Text>
      {question.recommendation ? (
        <Text style={styles.recommendation}>→ {question.recommendation}</Text>
      ) : null}
    </View>
  );
}

/**
 * Read-only, on purpose (hands#107 scope): shows what's waiting on the
 * principal, doesn't make it answerable — hands_answer/hands_escalate stay
 * a decision made from the dashboard/CLI, not a mutation this app can send.
 */
export function NeedsYouScreen({ stream }: { stream: HandsStreamState }) {
  const open = (stream.snapshot?.questions ?? []).filter((q) => q.state === "open");
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ConnectionBanner connected={stream.connected} lastError={stream.lastError} />
      <FlatList
        data={open}
        keyExtractor={(q) => String(q.id)}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          stream.connected ? <Text style={styles.empty}>Nothing needs you right now.</Text> : null
        }
        renderItem={({ item }) => <QuestionRow question={item} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  listContent: { padding: spacing.lg },
  empty: { color: colors.muted, fontFamily: fonts.ui, padding: spacing.lg },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  question: { color: colors.paper, fontFamily: fonts.ui, fontSize: 15, marginBottom: spacing.xs },
  meta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
  recommendation: { color: colors.accent, fontFamily: fonts.ui, fontSize: 13, marginTop: spacing.xs },
});
