import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useContext, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
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
}) {
  return (
    <View style={styles.userGroup}>
      {props.text ? (
        <FocusableBlock
          ref={focusRef}
          style={styles.userBubble}
          focusedStyle={styles.userBubbleFocused}
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
}) {
  const scope = useContext(ThreadImageScopeContext);
  const blocks = useMemo(() => renderMarkdownBlocks(props.text), [props.text]);
  return (
    <View style={styles.assistantRow}>
      {blocks.map((block, index) => {
        const blockRef = index === blocks.length - 1 ? focusRef : undefined;
        return block.kind === "image" ? (
          <View key={block.key} style={styles.markdownImage}>
            <ThreadImage
              ref={blockRef}
              source={markdownImageSource(block.href, scope)}
              label={block.alt || block.href}
            />
          </View>
        ) : (
          <FocusableBlock key={block.key} ref={blockRef} style={styles.assistantBlock}>
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
}) {
  const failed = props.status === "failed";
  const running = props.status === "running" || props.status === "pending";
  return (
    <FocusableBlock ref={focusRef} style={styles.toolRow}>
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
}) {
  return (
    <FocusableBlock ref={focusRef} style={styles.noticeRow}>
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
}) {
  return (
    <FocusableBlock ref={focusRef} style={styles.toolRow}>
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
  focusRef,
}: {
  readonly row: ThreadRow;
  readonly focusRef: Ref<ViewInstance> | undefined;
}) {
  switch (row.kind) {
    case "user":
      return <UserRow focusRef={focusRef} text={row.text} images={row.images} />;
    case "assistant":
      return (
        <AssistantRow
          focusRef={focusRef}
          text={row.text}
          images={row.images}
          streaming={row.streaming}
        />
      );
    case "tool":
      return (
        <ToolRow focusRef={focusRef} name={row.name} preview={row.preview} status={row.status} />
      );
    case "notice":
      return <NoticeRow focusRef={focusRef} text={row.text} tone={row.tone} />;
    case "subagents":
      return (
        <SubagentsRow
          focusRef={focusRef}
          label={row.label}
          statusSummary={row.statusSummary}
          active={row.active}
          failed={row.failed}
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
  /** Scrolls to the start and moves focus to the first message. */
  readonly focusFirst: () => void;
}

// react-native-tvos adds requestTVFocus to View instances at runtime; its types omit it.
function requestTVFocus(view: ViewInstance | null) {
  (view as { requestTVFocus?: () => void } | null)?.requestTVFocus?.();
}

export function ThreadMessageList({
  ref,
  ...props
}: {
  readonly ref?: Ref<ThreadMessageListHandle>;
  readonly rows: ReadonlyArray<ThreadRow>;
  /** The newest block's host, owned by the parent so it can be a focus guide destination. */
  readonly latestHost: ViewInstance | null;
  /** A state setter (stable) that receives the newest block's host. */
  readonly latestHostRef: (host: ViewInstance | null) => void;
  readonly emptyLabel: string;
  /** Images resolve against this thread; without it they show as unavailable. */
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const imageScope = useThreadImageScope(props.environmentId, props.threadId);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const followEnd = useRef(true);
  const { latestHost, latestHostRef } = props;
  const firstRef = useRef<ViewInstance>(null);
  useImperativeHandle(
    ref,
    () => ({
      focusLatest: () => {
        followEnd.current = true;
        scrollRef.current?.scrollToEnd({ animated: true });
        requestTVFocus(latestHost);
      },
      focusFirst: () => {
        followEnd.current = false;
        scrollRef.current?.scrollTo({ y: 0, animated: true });
        requestTVFocus(firstRef.current ?? latestHost);
      },
    }),
    [latestHost],
  );

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    followEnd.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < FOLLOW_THRESHOLD_PX;
  };

  return (
    <ThreadImageScopeContext.Provider value={imageScope}>
      {/* No autoFocus guide: with nothing remembered it enters at the top-leading block, the
          first message. Plain geometry enters from the toolbar at the nearest, newest block. */}
      <View style={styles.root}>
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
                // A row's ref lands on its last block; a first row is usually a one-block prompt.
                focusRef={
                  index === props.rows.length - 1
                    ? latestHostRef
                    : index === 0
                      ? firstRef
                      : undefined
                }
              />
            ))
          )}
        </ScrollView>
      </View>
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
