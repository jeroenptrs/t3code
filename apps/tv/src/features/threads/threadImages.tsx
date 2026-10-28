import { useAtomValue } from "@effect/atom-react";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
  type AssetUrlState,
} from "@t3tools/client-runtime/state/assets";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { Image } from "expo-image";
import { createContext, memo, useContext, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, typography } from "../../components/theme";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentPresentations, environmentSession } from "../../state/environments";
import type { ThreadImageAttachment } from "./threadRows";

const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export interface ThreadImageScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null;
}

export const ThreadImageScopeContext = createContext<ThreadImageScope | null>(null);

/** Where an image's bytes come from: a URL as written, or a resource the environment signs. */
export type ThreadImageSource =
  | { readonly access: "direct"; readonly uri: string }
  | { readonly access: "environment"; readonly resource: AssetResource };

export function attachmentImageSource(image: ThreadImageAttachment): ThreadImageSource {
  return {
    access: "environment",
    resource: {
      _tag: "attachment",
      attachmentId: image.id,
      fileName: image.name,
      mimeType: image.mimeType,
    },
  };
}

export function markdownImageSource(
  href: string,
  scope: ThreadImageScope | null,
): ThreadImageSource | null {
  const media = resolveMediaSource(href, {
    threadId: scope?.threadId,
    workspaceRoot: scope?.workspaceRoot,
    imageEmbed: true,
  });
  if (media === null || media.kind !== "image") return null;
  if (media.access === "direct") return { access: "direct", uri: media.uri };
  if (media.access === "environment") return { access: "environment", resource: media.resource };
  return null;
}

const NO_PRESENTATION = Atom.make(null);
const NO_SESSION = Atom.make(null);
const NO_CONNECTION = Atom.make(Option.none<{ readonly httpBaseUrl: string }>());
const NO_FILE_ACCESS = { canReadFiles: false, isPending: true, error: null } as const;

/**
 * Asset routes take a signed, expiring token in the path, so the URL works in a plain image
 * request with no session header; the RPC that mints it runs over the paired connection.
 */
function useImageUrl(source: ThreadImageSource | null): AssetUrlState {
  const scope = useContext(ThreadImageScopeContext);
  const environmentId = scope?.environmentId ?? null;
  const resource = source?.access === "environment" ? source.resource : null;
  const presentation = useAtomValue(
    environmentId === null
      ? NO_PRESENTATION
      : environmentPresentations.presentationAtom(environmentId),
  );
  const session = useAtomValue(
    environmentId === null ? NO_SESSION : environmentSession.sessionStateValueAtom(environmentId),
  );
  const connection = useAtomValue(
    environmentId === null
      ? NO_CONNECTION
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const fileAccess =
    environmentId === null
      ? NO_FILE_ACCESS
      : resolveFilesystemReadAccess({
          isCatalogReady: true,
          connection: presentation?.connection ?? null,
          session,
          sessionError: null,
        });
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const result = useAtomValue(
    blocked !== null || environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (source === null) return { _tag: "Failure" };
  if (source.access === "direct") {
    return { _tag: "Success", url: source.uri, expiresAt: Number.POSITIVE_INFINITY };
  }
  if (environmentId === null) return { _tag: "Failure" };
  if (blocked !== null) return blocked;
  const state = assetUrlStateFromResult(
    result,
    connection._tag === "Some" ? connection.value.httpBaseUrl : null,
  );
  return state._tag === "Failure" && result.waiting ? { _tag: "Loading" } : state;
}

const THUMBNAIL_MAX_WIDTH = 480;
const THUMBNAIL_MAX_HEIGHT = 360;
const FALLBACK_ASPECT = 4 / 3;

function thumbnailSize(aspect: number) {
  const width = Math.min(THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT * aspect);
  return { width, height: width / aspect };
}

/**
 * An inline image, bounded to a thumbnail and its own focus stop. Select opens it full screen;
 * Menu closes that view.
 */
export const ThreadImage = memo(function ThreadImage(props: {
  readonly source: ThreadImageSource | null;
  readonly label: string;
  readonly hasTVPreferredFocus?: boolean;
}) {
  const state = useImageUrl(props.source);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedAspect, setLoadedAspect] = useState<number | null>(null);
  const dimensions = state._tag === "Success" ? state.imageDimensions : undefined;
  const aspect =
    loadedAspect ?? (dimensions ? dimensions.width / dimensions.height : FALLBACK_ASPECT);
  const url = state._tag === "Success" && state.url !== failedUrl ? state.url : null;
  const placeholder =
    state._tag === "Loading"
      ? "Loading image…"
      : state._tag === "Failure" && state.reason === "missing-file-access"
        ? "Pair again with file access to see this image"
        : "Image unavailable";

  return (
    <>
      <Pressable
        hasTVPreferredFocus={props.hasTVPreferredFocus}
        disabled={url === null && state._tag !== "Loading"}
        onPress={() => {
          if (url !== null) setOpen(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.thumbnail, thumbnailSize(aspect), focused && styles.thumbnailFocused]}
      >
        {url !== null ? (
          <Image
            source={{ uri: url }}
            style={styles.fill}
            contentFit="cover"
            accessibilityLabel={props.label}
            onLoad={(event) => {
              const { width, height } = event.source;
              if (width > 0 && height > 0) setLoadedAspect(width / height);
            }}
            onError={() => setFailedUrl(url)}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText} numberOfLines={2}>
              {placeholder}
            </Text>
            <Text style={styles.placeholderName} numberOfLines={1}>
              {props.label}
            </Text>
          </View>
        )}
      </Pressable>
      {url !== null ? (
        <Modal visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.viewer}>
            <Image
              source={{ uri: url }}
              style={styles.fill}
              contentFit="contain"
              accessibilityLabel={props.label}
            />
            <Text style={styles.viewerHint}>Press Menu to close</Text>
          </View>
        </Modal>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  thumbnail: {
    borderRadius: 12,
    borderWidth: 4,
    borderColor: "transparent",
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  thumbnailFocused: { borderColor: colors.accent },
  fill: { flex: 1 },
  placeholder: { flex: 1, justifyContent: "center", padding: 20, gap: 6 },
  placeholderText: { color: colors.textMuted, ...typography.small },
  placeholderName: { color: colors.text, ...typography.small },
  viewer: { flex: 1, backgroundColor: "#000" },
  viewerHint: {
    position: "absolute",
    bottom: 36,
    alignSelf: "center",
    color: colors.textMuted,
    ...typography.small,
  },
});
