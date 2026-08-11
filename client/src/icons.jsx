import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  AlertCircleIcon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  CheckmarkSquare02Icon,
  Clock01Icon,
  CloudUploadIcon,
  Download04Icon,
  File01Icon,
  Link01Icon,
  Menu01Icon,
  PackageIcon,
  PlayIcon,
  RefreshIcon,
  Search01Icon,
  Tag01Icon,
  Tick02Icon,
  TruckIcon,
} from "@hugeicons/core-free-icons";

/**
 * The app's icon vocabulary — one library, one place (Hugeicons).
 *
 * Hugeicons ships icons as DATA (arrays of [tag, attrs]) rendered by a single
 * <HugeiconsIcon icon={…}/> component, not as one component per icon. Call
 * sites here pass icons around as component references — the step nav in
 * App.jsx and the tab strip in Upload.jsx both do `icon: SomeIcon` and render
 * `<Icon className="…"/>` later — which that data shape cannot satisfy on its
 * own. Wrapping each icon back into a component keeps those call sites working
 * unchanged and keeps the icon set enumerable in one file rather than spread
 * across seven pages.
 *
 * Props pass straight through (HugeiconsIconProps extends SVGProps), so the
 * existing Tailwind sizing classes and aria attributes still apply. Size is
 * deliberately left to those classes: every call site sets its own h-/w-, and
 * CSS overrides the width/height attributes the component emits.
 */
const icon = (glyph, name) => {
  const Component = (props) => <HugeiconsIcon icon={glyph} {...props} />;
  Component.displayName = name;
  return Component;
};

export const IconAlertCircle = icon(AlertCircleIcon, "IconAlertCircle");
export const IconAlertTriangle = icon(Alert02Icon, "IconAlertTriangle");
export const IconBox = icon(PackageIcon, "IconBox");
export const IconCheck = icon(Tick02Icon, "IconCheck");
export const IconCheckCircle = icon(CheckmarkCircle02Icon, "IconCheckCircle");
export const IconCheckSquare = icon(CheckmarkSquare02Icon, "IconCheckSquare");
export const IconClock = icon(Clock01Icon, "IconClock");
export const IconDownload = icon(Download04Icon, "IconDownload");
export const IconFile = icon(File01Icon, "IconFile");
export const IconLink = icon(Link01Icon, "IconLink");
export const IconMenu = icon(Menu01Icon, "IconMenu");
export const IconPlay = icon(PlayIcon, "IconPlay");
export const IconRefreshCw = icon(RefreshIcon, "IconRefreshCw");
export const IconSearch = icon(Search01Icon, "IconSearch");
export const IconTag = icon(Tag01Icon, "IconTag");
export const IconTruck = icon(TruckIcon, "IconTruck");
export const IconUploadCloud = icon(CloudUploadIcon, "IconUploadCloud");
export const IconX = icon(Cancel01Icon, "IconX");
export const IconXCircle = icon(CancelCircleIcon, "IconXCircle");
