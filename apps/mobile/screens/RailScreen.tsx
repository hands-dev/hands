import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionBanner } from "../theme/ConnectionBanner";
import { colors, fonts, spacing } from "../theme/theme";
import type { HandsStreamState } from "../lib/useHandsStream";
import type { MobileTask } from "../types/hands-snapshot";

interface DishGroup {
  dish: string;
  tasks: MobileTask[];
}

/** Same grouping rule as plugin/skills/rail/SKILL.md: group by dish in array order, no re-sorting; a missing dish goes under "unattached". */
function groupByDish(tasks: MobileTask[]): DishGroup[] {
  const groups: DishGroup[] = [];
  const index = new Map<string, DishGroup>();
  for (const task of tasks) {
    const key = task.dish ?? "unattached";
    let group = index.get(key);
    if (!group) {
      group = { dish: key, tasks: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function TaskRow({ task }: { task: MobileTask }) {
  return (
    <View style={styles.taskRow}>
      <Text style={styles.taskTitle}>
        #{task.id} {task.title}
      </Text>
      <Text style={styles.taskMeta}>
        {task.assignee} · {task.state}
        {task.priority ? ` · ${task.priority}` : ""}
      </Text>
    </View>
  );
}

export function RailScreen({ stream }: { stream: HandsStreamState }) {
  const groups = groupByDish(stream.snapshot?.tasks ?? []);
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ConnectionBanner connected={stream.connected} lastError={stream.lastError} />
      <FlatList
        data={groups}
        keyExtractor={(g) => g.dish}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          stream.connected ? <Text style={styles.empty}>No active tickets.</Text> : null
        }
        renderItem={({ item }) => (
          <View style={styles.group}>
            <Text style={styles.dishTitle}>{item.dish}</Text>
            {item.tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  listContent: { padding: spacing.lg },
  empty: { color: colors.muted, fontFamily: fonts.ui, padding: spacing.lg },
  group: { marginBottom: spacing.lg },
  dishTitle: {
    color: colors.accent,
    fontFamily: fonts.uiMedium,
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  taskRow: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  taskTitle: { color: colors.paper, fontFamily: fonts.ui, fontSize: 15, marginBottom: spacing.xs },
  taskMeta: { color: colors.muted, fontFamily: fonts.mono, fontSize: 12 },
});
