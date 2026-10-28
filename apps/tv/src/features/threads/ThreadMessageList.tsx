import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useContext, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TVFocusGuideView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from "react-native";

import { Atom } from "effect/reactivity";

import { FocusableBlock } from "../../components/FocusableBlock";
import { colors, typography } from "../../components/theme";
import { environmentProjects, environmentThreadShells } from "../../state/environments";
import { renderMarkdownBlocks } from "./markdown";
import {
  attachmentImageSource,
  markdownImageSource,
  ThreadImage,
  ThreadImageScopeContext,
  type ThreadImageScope,
} from "./threadImages";
import type { ThreadImageAttachment, ThreadRow } from "./threadRows";

// Within this distance of the end, new and streamed content keeps the list pinned to the end.
const FOLLOW_THRESHOLD_PX = 160;

function AttachmentImages(props: { readonly images: ReadonlyArray<ThreadImageAttachment> }) {
  if (props.images.length === 0) return null;
  return (
    <View style={styles.images}>
      {props.images.map((image) => (
        <ThreadImage key={image.id} source={attachmentImageSource(image)} label={image.name} />
      ))}
    </View>
  );
}

const UserRow = memo(function UserRow(props: {
  readonly text: string;
  readonly images: ReadonlyArray<ThreadImageAttachment>;
  readonly preferred: boolean;
}) {
  return (
    <View style={styles.userGroup}>
      <FocusableBlock style={styles.userRow} hasTVPreferredFocus={props.preferred}>
        <Text style={styles.roleLabel}>You</Text>
        {props.text ? <Text style={styles.userText}>{props.text}</Text> : null}
      </FocusableBlock>
      <AttachmentImages images={props.images} />
    </View>
  );
});

const AssistantRow = memo(function AssistantRow(props: {
  readonly text: string;
  readonly images: ReadonlyArray<ThreadImageAttachment>;
  readonly streaming: boolean;
  readonly preferred: boolean;
}) {
  const scope = useContext(ThreadImageScopeContext);
  const blocks = useMemo(() => renderMarkdownBlocks(props.text), [props.text]);
  return (
    <View style={styles.assistantRow}>
      {blocks.map((block, index) => {
        // While streaming, blocks keep appending, so the flag stays on the first block.
        const preferred = props.preferred && index === (props.streaming ? 0 : blocks.length - 1);
        return block.kind === "image" ? (
          <View key={block.key} style={styles.markdownImage}>
            <ThreadImage
              source={markdownImageSource(block.href, scope)}
              label={block.alt || block.href}
              hasTVPreferredFocus={preferred}
            />
          </View>
        ) : (
          <FocusableBlock
            key={block.key}
            style={styles.assistantBlock}
            hasTVPreferredFocus={preferred}
          >
            {block.element}
          </FocusableBlock>
        );
      })}
      <AttachmentImages images={props.images} />
      {props.streaming ? <Text style={styles.streaming}>▍ Writing…</Text> : null}
    </View>
  );
});

const ToolRow = memo(function ToolRow(props: {
  readonly name: string;
  readonly preview: string;
  readonly status: string;
  readonly preferred: boolean;
}) {
  const failed = props.status === "failed";
  const running = props.status === "running" || props.status === "pending";
  return (
    <FocusableBlock style={styles.toolRow} hasTVPreferredFocus={props.preferred}>
      <Text style={styles.toolText} numberOfLines={1}>
        <Text style={[styles.toolName, failed && styles.toolFailed]}>
          {running ? "◌ " : failed ? "✕ " : "✓ "}
          {props.name}
        </Text>
        {props.preview ? `  ${props.preview}` : ""}
      </Text>
    </FocusableBlock>
  );
});

const NoticeRow = memo(function NoticeRow(props: {
  readonly text: string;
  readonly tone: "muted" | "warning" | "danger";
  readonly preferred: boolean;
}) {
  return (
    <FocusableBlock style={styles.noticeRow} hasTVPreferredFocus={props.preferred}>
      <Text
        style={[
          styles.noticeText,
          props.tone === "warning" && { color: colors.warning },
          props.tone === "danger" && { color: colors.danger },
        ]}
        numberOfLines={3}
      >
        {props.text}
      </Text>
    </FocusableBlock>
  );
});

function Row(props: { readonly row: ThreadRow; readonly preferred: boolean }) {
  const { row, preferred } = props;
  switch (row.kind) {
    case "user":
      return <UserRow text={row.text} images={row.images} preferred={preferred} />;
    case "assistant":
      return (
        <AssistantRow
          text={row.text}
          images={row.images}
          streaming={row.streaming}
          preferred={preferred}
        />
      );
    case "tool":
      return (
        <ToolRow name={row.name} preview={row.preview} status={row.status} preferred={preferred} />
      );
    case "notice":
      return <NoticeRow text={row.text} tone={row.tone} preferred={preferred} />;
  }
}

/**
 * The thread feed. Every row, and every block of an assistant message, is a focus stop, so the
 * remote scrolls the list; it follows the end while the reader is there.
 */
export function ThreadMessageList(props: {
  readonly rows: ReadonlyArray<ThreadRow>;
  readonly emptyLabel: string;
  /** Images resolve against this thread; without it they show as unavailable. */
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const imageScope = useThreadImageScope(props.environmentId, props.threadId);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followEnd = useRef(true);
  // Focus starts on the newest row at open. Fixed after the first rows arrive, so rows
  // streamed in later never pull focus away from the reply box.
  const [initialFocusKey, setInitialFocusKey] = useState<string | null>(null);
  if (initialFocusKey === null && props.rows.length > 0) {
    setInitialFocusKey(props.rows[props.rows.length - 1]!.key);
  }

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    followEnd.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < FOLLOW_THRESHOLD_PX;
  };

  return (
    <ThreadImageScopeContext.Provider value={imageScope}>
      <TVFocusGuideView style={styles.root} autoFocus>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          onScroll={onScroll}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (followEnd.current) scrollRef.current?.scrollToEnd({ animated: false });
          }}
        >
          {props.rows.length === 0 ? (
            <Text style={styles.empty}>{props.emptyLabel}</Text>
          ) : (
            props.rows.map((row) => (
              <Row key={row.key} row={row} preferred={row.key === initialFocusKey} />
            ))
          )}
        </ScrollView>
      </TVFocusGuideView>
    </ThreadImageScopeContext.Provider>
  );
}

const NO_SHELL = Atom.make(null);
const NO_PROJECTS = Atom.make<ReadonlyArray<never>>([]);

/** The thread's cwd, its worktree or else its project root, the way mobile resolves it. */
function useThreadImageScope(
  environmentId: EnvironmentId | undefined,
  threadId: ThreadId | undefined,
): ThreadImageScope | null {
  const ref = useMemo(
    () =>
      environmentId === undefined || threadId === undefined ? null : { environmentId, threadId },
    [environmentId, threadId],
  );
  const shell = useAtomValue(
    ref === null ? NO_SHELL : environmentThreadShells.threadShellAtom(ref),
  );
  const projects = useAtomValue(
    environmentId === undefined
      ? NO_PROJECTS
      : environmentProjects.environmentProjectsAtom(environmentId),
  );
  const workspaceRoot =
    shell?.worktreePath ??
    projects.find((project) => project.id === shell?.projectId)?.workspaceRoot ??
    null;
  return useMemo(() => (ref === null ? null : { ...ref, workspaceRoot }), [ref, workspaceRoot]);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  content: { gap: 20, paddingVertical: 24, paddingRight: 24 },
  empty: { color: colors.textMuted, ...typography.body },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 16, paddingLeft: 30 },
  markdownImage: { paddingLeft: 30 },
  userGroup: { gap: 12 },
  roleLabel: { color: colors.textMuted, ...typography.small, fontWeight: "600" },
  userRow: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingVertical: 20,
    paddingRight: 28,
    gap: 6,
    marginTop: 16,
  },
  userText: { color: colors.text, ...typography.body },
  assistantRow: { gap: 14 },
  assistantBlock: { paddingVertical: 4 },
  streaming: { color: colors.accent, ...typography.small, paddingLeft: 30 },
  toolRow: { paddingVertical: 6 },
  toolText: { color: colors.textMuted, ...typography.small },
  toolName: { color: colors.text, fontWeight: "600" },
  toolFailed: { color: colors.danger },
  noticeRow: { paddingVertical: 6 },
  noticeText: { color: colors.textMuted, ...typography.small },
});
