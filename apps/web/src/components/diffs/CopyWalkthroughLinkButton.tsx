import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { CheckIcon, LinkIcon } from "lucide-react";
import { useRef } from "react";

import { isElectron } from "~/env";
import { configuredHostedAppUrl } from "~/hostedPairing";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useThreadRouteRef } from "~/hooks/useThreadRouteTarget";

import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { walkthroughShareUrl } from "./openWalkthrough.logic";

/** Copies a link that opens this walkthrough, expanded if it is now. */
export function CopyWalkthroughLinkButton() {
  const gt = useGT();
  const router = useRouter();
  const threadRef = useThreadRouteRef();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  const copy = () => {
    const hostedAppUrl = configuredHostedAppUrl();
    copyToClipboard(
      walkthroughShareUrl({
        href: router.state.location.href,
        // The desktop app's own origin opens nowhere else.
        origin: isElectron ? hostedAppUrl : window.location.origin,
        threadRef,
        hostedAppUrl,
      }),
      undefined,
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Copy link")}
            onClick={copy}
          />
        }
      >
        {isCopied ? <CheckIcon className="text-success" /> : <LinkIcon />}
      </TooltipTrigger>
      <TooltipPopup>{isCopied ? gt("Copied") : gt("Copy link")}</TooltipPopup>
    </Tooltip>
  );
}
