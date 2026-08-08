import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionBanner } from "../theme/ConnectionBanner";
import { colors, fonts, spacing, stationColor } from "../theme/theme";
import type { HandsStreamState } from "../lib/useHandsStream";
import type { AgentState, MobileAgent } from "../types/hands-snapshot";

const STATE_LABEL: Record<AgentState, string> = {
  active: "active",
  idle: "idle",
  offline: "offline",
};

function AgentRow({ agent }: { agent: MobileAgent }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: stationColor(agent.id) }]} />
      <View style={styles.rowBody}>
        <Text style={styles.id}>{agent.id}</Text>
        <Text style={styles.meta}>
          {STATE_LABEL[agent.state]}
          {agent.focus ? ` · ${agent.focus}` : ""}
          {agent.ticket ? ` · #${agent.ticket}` : ""}
        </Text>
      </View>
      <View style={[styles.statePip, agent.online ? styles.online : styles.offline]} />
    </View>
  );
}

export function LineScreen({ stream }: { stream: HandsStreamState }) {
  const agents = stream.snapshot?.agents ?? [];
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ConnectionBanner connected={stream.connected} lastError={stream.lastError} />
      <FlatList
        data={agents}
        keyExtractor={(a) => a.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          stream.connected ? <Text style={styles.empty}>No stations on the bus.</Text> : null
        }
        renderItem={({ item }) => <AgentRow agent={item} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  listContent: { padding: spacing.lg },
  empty: { color: colors.muted, fontFamily: fonts.ui, padding: spacing.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.md },
  rowBody: { flex: 1 },
  id: { color: colors.paper, fontFamily: fonts.uiMedium, fontSize: 15 },
  meta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12, marginTop: 2 },
  statePip: { width: 8, height: 8, borderRadius: 4 },
  online: { backgroundColor: colors.accent },
  offline: { backgroundColor: colors.line },
});
