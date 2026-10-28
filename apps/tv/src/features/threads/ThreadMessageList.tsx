import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useContext, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TVFocusGuideView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";

import { Atom } from "effect/reactivity";

import { FocusableBlock } from "../../components/FocusableBlock";
import { colors, conversation, typography } from "../../components/theme";
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

function AttachmentImages(props: {
  readonly images: ReadonlyArray<ThreadImageAttachment>;
  readonly align?: "end";
  readonly lastRef?: Ref<ViewInstance> | undefined;
}) {
  if (props.images.length === 0) return null;
  return (
    <View style={[styles.images, props.align === "end" && styles.imagesEnd]}>
      {props.images.map((image, index) => (
        <ThreadImage
          key={image.id}
          ref={index === props.images.length - 1 ? props.lastRef : undefined}
          source={attachmentImageSource(image)}
          label={image.name}
        />
      ))}
    </View>
  );
}

const UserRow = memo(function UserRow({
  focusRef,
  ...props
}: {
  readonly focusRef: Ref<ViewInstance> | undefined;
  readonly text: string;
  readonly images: ReadonlyArray<ThreadImageAttachment>;
  readonly preferred: boolean;
}) {
  return (
    <View style={styles.userGroup}>
      {props.text ? (
        <FocusableBlock
          ref={focusRef}
          style={styles.userBubble}
          focusedStyle={styles.userBubbleFocused}
          hasTVPreferredFocus={props.preferred}
        >
          <Text style={styles.userText}>{props.text}</Text>
        </FocusableBlock>
      ) : null}
      <AttachmentImages
        images={props.images}
        align="end"
        lastRef={props.text ? undefined : focusRef}
      />
    </View>
  );
});

const AssistantRow = memo(function AssistantRow({
  focusRef,
  ...props
}: {
  readonly focusRef: Ref<ViewInstance> | undefined;
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
        const blockRef = index === blocks.length - 1 ? focusRef : undefined;
        return block.kind === "image" ? (
          <View key={block.key} style={styles.markdownImage}>
            <ThreadImage
              ref={blockRef}
              source={markdownImageSource(block.href, scope)}
              label={block.alt || block.href}
              hasTVPreferredFocus={preferred}
            />
          </View>
        ) : (
          <FocusableBlock
            key={block.key}
            ref={blockRef}
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

const ToolRow = memo(function ToolRow({
  focusRef,
  ...props
}: {
  readonly focusRef: Ref<ViewInstance> | undefined;
  readonly name: string;
  readonly preview: string;
  readonly status: string;
  readonly preferred: boolean;
}) {
  const failed = props.status === "failed";
  const running = props.status === "running" || props.status === "pending";
  return (
    <FocusableBlock ref={focusRef} style={styles.toolRow} hasTVPreferredFocus={props.preferred}>
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

const NoticeRow = memo(function NoticeRow({
  focusRef,
  ...props
}: {
  readonly focusRef: Ref<ViewInstance> | undefined;
  readonly text: string;
  readonly tone: "muted" | "warning" | "danger";
  readonly preferred: boolean;
}) {
  return (
    <FocusableBlock ref={focusRef} style={styles.noticeRow} hasTVPreferredFocus={props.preferred}>
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

const SubagentsRow = memo(function SubagentsRow({
  focusRef,
  ...props
}: {
  readonly focusRef: Ref<ViewInstance> | undefined;
  readonly label: string;
  readonly statusSummary: string;
  readonly active: boolean;
  readonly failed: boolean;
  readonly preferred: boolean;
}) {
  return (
    <FocusableBlock ref={focusRef} style={styles.toolRow} hasTVPreferredFocus={props.preferred}>
      <Text style={styles.toolText} numberOfLines={1}>
        <Text style={[styles.toolName, props.failed && styles.toolFailed]}>
          {props.active ? "◌ " : props.failed ? "✕ " : "✓ "}
          {props.label}
        </Text>
        {props.statusSummary ? `  ${props.statusSummary}` : ""}
      </Text>
    </FocusableBlock>
  );
});

function Row({
  row,
  preferred,
  focusRef,
}: {
  readonly row: ThreadRow;
  readonly preferred: boolean;
  readonly focusRef: Ref<ViewInstance> | undefined;
}) {
  switch (row.kind) {
    case "user":
      return (
        <UserRow focusRef={focusRef} text={row.text} images={row.images} preferred={preferred} />
      );
    case "assistant":
      return (
        <AssistantRow
          focusRef={focusRef}
          text={row.text}
          images={row.images}
          streaming={row.streaming}
          preferred={preferred}
        />
      );
    case "tool":
      return (
        <ToolRow
          focusRef={focusRef}
          name={row.name}
          preview={row.preview}
          status={row.status}
          preferred={preferred}
        />
      );
    case "notice":
      return (
        <NoticeRow focusRef={focusRef} text={row.text} tone={row.tone} preferred={preferred} />
      );
    case "subagents":
      return (
        <SubagentsRow
          focusRef={focusRef}
          label={row.label}
          statusSummary={row.statusSummary}
          active={row.active}
          failed={row.failed}
          preferred={preferred}
        />
      );
  }
}

/**
 * The thread feed. Every row, and every block of an assistant message, is a focus stop, so the
 * remote scrolls the list; it follows the end while the reader is there.
 */
export interface ThreadMessageListHandle {
  /** Scrolls to the end and moves focus to the newest message. */
  readonly focusLatest: () => void;
}

export function ThreadMessageList({
  ref,
  ...props
}: {
  readonly ref?: Ref<ThreadMessageListHandle>;
  readonly rows: ReadonlyArray<ThreadRow>;
  /** Whether the newest row takes focus when the rows first arrive. */
  readonly claimInitialFocus?: boolean;
  readonly emptyLabel: string;
  /** Images resolve against this thread; without it they show as unavailable. */
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const imageScope = useThreadImageScope(props.environmentId, props.threadId);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followEnd = useRef(true);
  const latestRef = useRef<ViewInstance>(null);
  useImperativeHandle(
    ref,
    () => ({
      focusLatest: () => {
        followEnd.current = true;
        scrollRef.current?.scrollToEnd({ animated: true });
        // react-native-tvos adds requestTVFocus to View instances at runtime; its types omit it.
        (latestRef.current as { requestTVFocus?: () => void } | null)?.requestTVFocus?.();
      },
    }),
    [],
  );
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
            props.rows.map((row, index) => (
              <Row
                key={row.key}
                row={row}
                preferred={props.claimInitialFocus !== false && row.key === initialFocusKey}
                focusRef={index === props.rows.length - 1 ? latestRef : undefined}
              />
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
  imagesEnd: { justifyContent: "flex-end", paddingLeft: 0 },
  markdownImage: { paddingLeft: 30 },
  // Mobile's user bubble: right-aligned, at most 85% of the feed.
  userGroup: { gap: 12, alignItems: "flex-end", marginTop: 16 },
  userBubble: {
    ...conversation.userBubble,
    maxWidth: "85%",
    paddingHorizontal: 30,
    paddingVertical: 22,
    borderWidth: 3,
    borderLeftWidth: 3,
    borderColor: "transparent",
    borderLeftColor: "transparent",
  },
  userBubbleFocused: {
    backgroundColor: conversation.userBubble.backgroundColor,
    borderColor: colors.accent,
    borderLeftColor: colors.accent,
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
