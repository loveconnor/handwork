/** Shared application icons, sourced exclusively from Honest UI. */
import {
  forwardRef,
  type SVGProps,
  type RefAttributes,
  type ComponentType,
} from "react";
import {
  AppWindow as HonestAppWindow,
  Archive as HonestArchive,
  ArrowLeft as HonestArrowLeft,
  ArrowUp as HonestArrowUp,
  BellOff as HonestBellOff,
  CaseSensitive as HonestCaseSensitive,
  ChartNoAxesCombined as HonestChartNoAxesCombined,
  Check as HonestCheck,
  CheckCheck as HonestCheckCheck,
  ChevronDown as HonestChevronDown,
  ChevronLeft as HonestChevronLeft,
  ChevronRight as HonestChevronRight,
  ChevronUp as HonestChevronUp,
  ChevronsUpDown as HonestChevronsUpDown,
  Circle as HonestCircle,
  CircleAlert as HonestCircleAlert,
  CircleArrowDown as HonestCircleArrowDown,
  CircleCheck as HonestCircleCheck,
  CircleDashed as HonestCircleDashed,
  CircleDot as HonestCircleDot,
  CircleQuestionMark as HonestCircleQuestionMark,
  CircleX as HonestCircleX,
  Clock as HonestClock,
  CloudUpload as HonestCloudUpload,
  Code as HonestCode,
  Copy as HonestCopy,
  CornerDownRight as HonestCornerDownRight,
  Ellipsis as HonestEllipsis,
  ExternalLink as HonestExternalLink,
  Eye as HonestEye,
  File as HonestFile,
  FileArchive as HonestFileArchive,
  FileBraces as HonestFileBraces,
  FileCode as HonestFileCode,
  FileDiff as HonestFileDiff,
  FileImage as HonestFileImage,
  FileMusic as HonestFileMusic,
  FilePlus as HonestFilePlus,
  FilePlusCorner as HonestFilePlusCorner,
  FileText as HonestFileText,
  FileVideoCamera as HonestFileVideoCamera,
  FoldVertical as HonestFoldVertical,
  Folder as HonestFolder,
  FolderOpen as HonestFolderOpen,
  FolderPlus as HonestFolderPlus,
  FolderTree as HonestFolderTree,
  Gauge as HonestGauge,
  Ghost as HonestGhost,
  GitBranch as HonestGitBranch,
  GitCompare as HonestGitCompare,
  GitMerge as HonestGitMerge,
  GitPullRequest as HonestGitPullRequest,
  GitPullRequestClosed as HonestGitPullRequestClosed,
  GitPullRequestDraft as HonestGitPullRequestDraft,
  Globe as HonestGlobe,
  GripVertical as HonestGripVertical,
  ImagePlus as HonestImagePlus,
  Keyboard as HonestKeyboard,
  LayoutDashboard as HonestLayoutDashboard,
  Lightbulb as HonestLightbulb,
  List as HonestList,
  ListEnd as HonestListEnd,
  ListFilter as HonestListFilter,
  Loader as HonestLoader,
  LoaderCircle as HonestLoaderCircle,
  Lock as HonestLock,
  Maximize2 as HonestMaximize2,
  MessageSquare as HonestMessageSquare,
  MessageSquarePlus as HonestMessageSquarePlus,
  MessagesSquare as HonestMessagesSquare,
  Minus as HonestMinus,
  MousePointer2 as HonestMousePointer2,
  Palette as HonestPalette,
  PanelBottom as HonestPanelBottom,
  PanelLeft as HonestPanelLeft,
  PanelRight as HonestPanelRight,
  PanelRightClose as HonestPanelRightClose,
  PanelTop as HonestPanelTop,
  Pause as HonestPause,
  PenLine as HonestPenLine,
  Pencil as HonestPencil,
  Pin as HonestPin,
  PinOff as HonestPinOff,
  Pipette as HonestPipette,
  Play as HonestPlay,
  Plus as HonestPlus,
  RefreshCw as HonestRefreshCw,
  Regex as HonestRegex,
  Replace as HonestReplace,
  RotateCcw as HonestRotateCcw,
  Search as HonestSearch,
  Settings as HonestSettings,
  Share as HonestShare,
  Shield as HonestShield,
  SlidersHorizontal as HonestSlidersHorizontal,
  Smartphone as HonestSmartphone,
  SmilePlus as HonestSmilePlus,
  Sparkles as HonestSparkles,
  Square as HonestSquare,
  SquarePlus as HonestSquarePlus,
  Star as HonestStar,
  StickyNote as HonestStickyNote,
  Terminal as HonestTerminal,
  Trash2 as HonestTrash2,
  Undo2 as HonestUndo2,
  UnfoldVertical as HonestUnfoldVertical,
  Ungroup as HonestUngroup,
  WandSparkles as HonestWandSparkles,
  WholeWord as HonestWholeWord,
  Wrench as HonestWrench,
  X as HonestX,
  Zap as HonestZap,
  Download as HonestDownload,
  ZoomIn as HonestZoomIn,
  ZoomOut as HonestZoomOut,
} from "honestui/icons";
export type IconProps = Omit<SVGProps<SVGSVGElement>, "strokeWidth" | "ref"> & {
  size?: number | string;
  strokeWidth?: number;
};
export type IconComponent = ReturnType<typeof wrap>;
function wrap(
  Component: ComponentType<IconProps & RefAttributes<SVGSVGElement>>,
  name: string,
) {
  const Icon = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <Component
      ref={ref}
      aria-hidden="true"
      data-honest-icon={name}
      {...props}
    />
  ));
  Icon.displayName = name;
  return Icon;
}
export const AlertCircle = wrap(HonestCircleAlert, "AlertCircle");
export const AppWindow = wrap(HonestAppWindow, "AppWindow");
export const Archive = wrap(HonestArchive, "Archive");
export const ArrowDownCircle = wrap(HonestCircleArrowDown, "ArrowDownCircle");
export const ArrowLeft = wrap(HonestArrowLeft, "ArrowLeft");
export const ArrowUp = wrap(HonestArrowUp, "ArrowUp");
export const Ghost = wrap(HonestGhost, "Ghost");
export const AiIdea = wrap(HonestLightbulb, "AiIdea");
export const CaseSensitive = wrap(HonestCaseSensitive, "CaseSensitive");
export const Chatting = wrap(HonestMessagesSquare, "Chatting");
export const Check = wrap(HonestCheck, "Check");
export const CheckCheck = wrap(HonestCheckCheck, "CheckCheck");
export const CheckCircle = wrap(HonestCircleCheck, "CheckCircle");
export const ChevronDown = wrap(HonestChevronDown, "ChevronDown");
export const ChevronLeft = wrap(HonestChevronLeft, "ChevronLeft");
export const ChevronRight = wrap(HonestChevronRight, "ChevronRight");
export const CornerDownRight = wrap(HonestCornerDownRight, "CornerDownRight");
export const ChevronUp = wrap(HonestChevronUp, "ChevronUp");
export const ChevronsUpDown = wrap(HonestChevronsUpDown, "ChevronsUpDown");
export const CircleAlert = wrap(HonestCircleAlert, "CircleAlert");
export const CircleDashed = wrap(HonestCircleDashed, "CircleDashed");
export const CircleDot = wrap(HonestCircleDot, "CircleDot");
export const CircleHelp = wrap(HonestCircleQuestionMark, "CircleHelp");
export const CircleX = wrap(HonestCircleX, "CircleX");
export const CloudUpload = wrap(HonestCloudUpload, "CloudUpload");
export const Clock = wrap(HonestClock, "Clock");
export const Code = wrap(HonestCode, "Code");
export const Copy = wrap(HonestCopy, "Copy");
export const CursorMagicSelection = wrap(
  HonestMousePointer2,
  "CursorMagicSelection",
);
export const DashboardSquare = wrap(HonestLayoutDashboard, "DashboardSquare");
export const ExternalLink = wrap(HonestExternalLink, "ExternalLink");
export const File = wrap(HonestFile, "File");
export const FileDiff = wrap(HonestFileDiff, "FileDiff");
export const FilePlus = wrap(HonestFilePlus, "FilePlus");
export const FilePlusCorner = wrap(HonestFilePlusCorner, "FilePlusCorner");
export const FileScript = wrap(HonestFileCode, "FileScript");
export const FoldVertical = wrap(HonestFoldVertical, "FoldVertical");
export const Folder = wrap(HonestFolder, "Folder");
export const FolderOpen = wrap(HonestFolderOpen, "FolderOpen");
export const Eye = wrap(HonestEye, "Eye");
export const FolderPlus = wrap(HonestFolderPlus, "FolderPlus");
export const FolderTree = wrap(HonestFolderTree, "FolderTree");
export const Gauge = wrap(HonestGauge, "Gauge");
export const ChartBreakoutSquare = wrap(
  HonestChartNoAxesCombined,
  "ChartBreakoutSquare",
);
export const GitBranch = wrap(HonestGitBranch, "GitBranch");
export const GitCompare = wrap(HonestGitCompare, "GitCompare");
export const GitMerge = wrap(HonestGitMerge, "GitMerge");
export const GitPullRequest = wrap(HonestGitPullRequest, "GitPullRequest");
export const GitPullRequestClosed = wrap(
  HonestGitPullRequestClosed,
  "GitPullRequestClosed",
);
export const GitPullRequestDraft = wrap(
  HonestGitPullRequestDraft,
  "GitPullRequestDraft",
);
export const GripVertical = wrap(HonestGripVertical, "GripVertical");
export const Globe = wrap(HonestGlobe, "Globe");
export const Internet = wrap(HonestGlobe, "Internet");
export const ImagePlus = wrap(HonestImagePlus, "ImagePlus");
export const BellOff = wrap(HonestBellOff, "BellOff");
export const Keyboard = wrap(HonestKeyboard, "Keyboard");
export const ListBullet = wrap(HonestList, "ListBullet");
export const ListEnd = wrap(HonestListEnd, "ListEnd");
export const ListFilter = wrap(HonestListFilter, "ListFilter");
export const Loader = wrap(HonestLoader, "Loader");
export const LoaderCircle = wrap(HonestLoaderCircle, "LoaderCircle");
export const Lock = wrap(HonestLock, "Lock");
export const Maximize2 = wrap(HonestMaximize2, "Maximize2");
export const MessageMultiple = wrap(HonestMessagesSquare, "MessageMultiple");
export const MessageSquare = wrap(HonestMessageSquare, "MessageSquare");
export const MessageSquarePlus = wrap(
  HonestMessageSquarePlus,
  "MessageSquarePlus",
);
export const Minus = wrap(HonestMinus, "Minus");
export const MoreHorizontal = wrap(HonestEllipsis, "MoreHorizontal");
export const Palette = wrap(HonestPalette, "Palette");
export const Pause = wrap(HonestPause, "Pause");
export const PanelBottom = wrap(HonestPanelBottom, "PanelBottom");
export const PanelLeft = wrap(HonestPanelLeft, "PanelLeft");
export const PanelRight = wrap(HonestPanelRight, "PanelRight");
export const PanelRightToggle = wrap(HonestPanelRightClose, "PanelRightToggle");
export const PanelTop = wrap(HonestPanelTop, "PanelTop");
export const PenLine = wrap(HonestPenLine, "PenLine");
export const Pencil = wrap(HonestPencil, "Pencil");
export const Pin = wrap(HonestPin, "Pin");
export const PinOff = wrap(HonestPinOff, "PinOff");
export const Play = wrap(HonestPlay, "Play");
export const Pipette = wrap(HonestPipette, "Pipette");
export const Plus = wrap(HonestPlus, "Plus");
export const RefreshCw = wrap(HonestRefreshCw, "RefreshCw");
export const Regex = wrap(HonestRegex, "Regex");
export const Replace = wrap(HonestReplace, "Replace");
export const RotateCcw = wrap(HonestRotateCcw, "RotateCcw");
export const Search = wrap(HonestSearch, "Search");
export const Settings = wrap(HonestSettings, "Settings");
export const Share = wrap(HonestShare, "Share");
export const Shield = wrap(HonestShield, "Shield");
export const SlidersHorizontal = wrap(
  HonestSlidersHorizontal,
  "SlidersHorizontal",
);
export const SmartPhone = wrap(HonestSmartphone, "SmartPhone");
export const SmilePlus = wrap(HonestSmilePlus, "SmilePlus");
export const Sparkles = wrap(HonestSparkles, "Sparkles");
export const Square = wrap(HonestSquare, "Square");
export const SquarePlus = wrap(HonestSquarePlus, "SquarePlus");
export const Star = wrap(HonestStar, "Star");
export const StickyNote = wrap(HonestStickyNote, "StickyNote");
export const Terminal = wrap(HonestTerminal, "Terminal");
export const Trash2 = wrap(HonestTrash2, "Trash2");
export const Undo2 = wrap(HonestUndo2, "Undo2");
export const UnfoldVertical = wrap(HonestUnfoldVertical, "UnfoldVertical");
export const Ungroup = wrap(HonestUngroup, "Ungroup");
export const WandSparkles = wrap(HonestWandSparkles, "WandSparkles");
export const WholeWord = wrap(HonestWholeWord, "WholeWord");
export const Wrench = wrap(HonestWrench, "Wrench");
export const X = wrap(HonestX, "X");
export const Zap = wrap(HonestZap, "Zap");
export const FileCode = wrap(HonestFileCode, "FileCode");
export const FileJson = wrap(HonestFileBraces, "FileJson");
export const FileText = wrap(HonestFileText, "FileText");
export const FileImage = wrap(HonestFileImage, "FileImage");
export const FileArchive = wrap(HonestFileArchive, "FileArchive");
export const FileMusic = wrap(HonestFileMusic, "FileMusic");
export const FileVideo = wrap(HonestFileVideoCamera, "FileVideo");
export const Circle = wrap(HonestCircle, "Circle");
export const Braces = wrap(HonestCode, "Braces");

export const Download = wrap(HonestDownload, "Download");
export const ZoomIn = wrap(HonestZoomIn, "ZoomIn");
export const ZoomOut = wrap(HonestZoomOut, "ZoomOut");
