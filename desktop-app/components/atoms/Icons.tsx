"use client";

import { forwardRef, type ComponentType, type Ref, type SVGProps } from "react";
import {
  ArrowDown, ArrowLeftRight, ArrowRight, ArrowUp, ArrowUpRight, Braces, Calendar, ChartColumn, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleCheck, CircleDot, Clock, Code, Copy, CornerDownLeft, Database, Ellipsis, ExternalLink, EyeOff, File, FileText, FolderOpen, Funnel, Globe, GripVertical, House,
  IceCreamCone, Info, Layers, LayoutGrid, Link, List, ListChecks, Lock, LockOpen, LogOut, Mail, Maximize2, Menu, MessageCircleQuestionMark, Mic, Minimize2, Moon, MousePointer2,
  PanelLeftClose, Paperclip, Pencil, Pin, Plus, RotateCcw, RotateCw, Scissors, Search, Settings, Share2, SlidersHorizontal, Smile, Sparkles, Square, SquareCheck,
  SquarePen, Sun, Table2, Terminal, TextAlignCenter, TextAlignStart, TextCursorInput, ThumbsDown, ThumbsUp, Trash2, User, UserPlus, X, Zap,
} from "honestui/icons";

/* One place for every interface glyph: honestui/icons with the stroke and
 * caps this design uses, so components never ship their own SVG paths. */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number };
export type IconComponent = ComponentType<IconProps>;
type Base = ComponentType<IconProps & { ref?: Ref<SVGSVGElement> }>;

function icon(BaseIcon: Base, name: string, defaults: Partial<IconProps> = {}): IconComponent {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <BaseIcon ref={ref} aria-hidden="true" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...defaults} {...props} />
  ));
  Wrapped.displayName = name;
  return Wrapped;
}

const filled = { fill: "currentColor", stroke: "none" } as const;

export const IconArrowDown = icon(ArrowDown, "IconArrowDown");
export const IconArrowLeftRight = icon(ArrowLeftRight, "IconArrowLeftRight");
export const IconArrowRight = icon(ArrowRight, "IconArrowRight");
export const IconArrowUp = icon(ArrowUp, "IconArrowUp");
export const IconArrowUpRight = icon(ArrowUpRight, "IconArrowUpRight");
export const IconBraces = icon(Braces, "IconBraces");
export const IconCalendar = icon(Calendar, "IconCalendar");
export const IconChart = icon(ChartColumn, "IconChart");
export const IconCheck = icon(Check, "IconCheck");
export const IconChevronDown = icon(ChevronDown, "IconChevronDown");
export const IconChevronLeft = icon(ChevronLeft, "IconChevronLeft");
export const IconChevronRight = icon(ChevronRight, "IconChevronRight");
export const IconChevronUp = icon(ChevronUp, "IconChevronUp");
export const IconCircleCheck = icon(CircleCheck, "IconCircleCheck");
export const IconClock = icon(Clock, "IconClock");
export const IconClose = icon(X, "IconClose");
export const IconCode = icon(Code, "IconCode");
export const IconCollapse = icon(Minimize2, "IconCollapse");
export const IconCopy = icon(Copy, "IconCopy");
export const IconDatabase = icon(Database, "IconDatabase");
export const IconEllipsis = icon(Ellipsis, "IconEllipsis");
export const IconExpand = icon(Maximize2, "IconExpand");
export const IconEyeOff = icon(EyeOff, "IconEyeOff");
export const IconFile = icon(File, "IconFile");
export const IconFileText = icon(FileText, "IconFileText");
export const IconFolderOpen = icon(FolderOpen, "IconFolderOpen");
export const IconFunnel = icon(Funnel, "IconFunnel");
export const IconGlobe = icon(Globe, "IconGlobe");
export const IconGrip = icon(GripVertical, "IconGrip");
export const IconHome = icon(House, "IconHome");
export const IconInfo = icon(Info, "IconInfo");
export const IconLayers = icon(Layers, "IconLayers");
export const IconLink = icon(Link, "IconLink");
export const IconLock = icon(Lock, "IconLock");
export const IconLockOpen = icon(LockOpen, "IconLockOpen");
export const IconList = icon(List, "IconList");
export const IconListChecks = icon(ListChecks, "IconListChecks");
export const IconMenu = icon(Menu, "IconMenu");
export const IconMic = icon(Mic, "IconMic");
export const IconMoon = icon(Moon, "IconMoon");
export const IconMoonFilled = icon(Moon, "IconMoonFilled", filled);
export const IconNewChat = icon(SquarePen, "IconNewChat");
export const IconPaperclip = icon(Paperclip, "IconPaperclip");
export const IconPencil = icon(Pencil, "IconPencil");
export const IconPin = icon(Pin, "IconPin");
export const IconPlus = icon(Plus, "IconPlus");
export const IconPointer = icon(MousePointer2, "IconPointer");
export const IconPopsicle = icon(IceCreamCone, "IconPopsicle");
export const IconRecord = icon(CircleDot, "IconRecord");
export const IconReply = icon(CornerDownLeft, "IconReply");
export const IconRetry = icon(RotateCw, "IconRetry");
export const IconUndo = icon(RotateCcw, "IconUndo");
export const IconSearch = icon(Search, "IconSearch");
export const IconSettings = icon(Settings, "IconSettings");
export const IconSidebar = icon(PanelLeftClose, "IconSidebar");
export const IconSignOut = icon(LogOut, "IconSignOut");
export const IconSparkles = icon(Sparkles, "IconSparkles");
export const IconSparklesFilled = icon(Sparkles, "IconSparklesFilled", filled);
export const IconStopFilled = icon(Square, "IconStopFilled", { fill: "currentColor" });
export const IconSun = icon(Sun, "IconSun");
export const IconTerminal = icon(Terminal, "IconTerminal");
export const IconTextLines = icon(TextAlignStart, "IconTextLines");
export const IconThumbsDown = icon(ThumbsDown, "IconThumbsDown");
export const IconThumbsUp = icon(ThumbsUp, "IconThumbsUp");
export const IconUser = icon(User, "IconUser");
export const IconUserAdd = icon(UserPlus, "IconUserAdd");
export const IconExternalLink = icon(ExternalLink, "IconExternalLink");
export const IconLayoutGrid = icon(LayoutGrid, "IconLayoutGrid");
export const IconMail = icon(Mail, "IconMail");
export const IconMessageQuestion = icon(MessageCircleQuestionMark, "IconMessageQuestion");
export const IconScissors = icon(Scissors, "IconScissors");
export const IconShare = icon(Share2, "IconShare");
export const IconSliders = icon(SlidersHorizontal, "IconSliders");
export const IconSmile = icon(Smile, "IconSmile");
export const IconSquareCheck = icon(SquareCheck, "IconSquareCheck");
export const IconTable = icon(Table2, "IconTable");
export const IconTextAlignCenter = icon(TextAlignCenter, "IconTextAlignCenter");
export const IconTextInput = icon(TextCursorInput, "IconTextInput");
export const IconTrash = icon(Trash2, "IconTrash");
export const IconZap = icon(Zap, "IconZap");
