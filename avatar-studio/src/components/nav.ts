import { AudioLines, Camera, Clapperboard, Film, FolderOpen, Music, Wand2, Eraser, Home, Languages, Layers3, LayoutTemplate, MessageSquare, Mic2, MonitorPlay, Palette, Settings, Users, Video, Sparkles } from "lucide-react";

/** The studio's pages, in the sidebar's order (quick find offers them too). */
export const NAV = [
  { href: "/home", label: "Home", icon: Home },
  { href: "/create", label: "Create video", icon: Clapperboard },
  { href: "/agent", label: "Video Agent", icon: Sparkles },
  { href: "/cinematic", label: "Cinematic", icon: Film },
  { href: "/footage", label: "B-roll", icon: MonitorPlay },
  { href: "/photos", label: "Photo shoot", icon: Camera },
  { href: "/videos", label: "My videos", icon: Video },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/batch", label: "Personalize", icon: Layers3 },
  { href: "/avatars", label: "Avatars", icon: Users },
  { href: "/voices", label: "Voices", icon: Mic2 },
  { href: "/assets", label: "Assets", icon: FolderOpen },
  { href: "/translate", label: "Video translate", icon: Languages },
  { href: "/cleanup", label: "Clean up", icon: Eraser },
  { href: "/lipsync", label: "Lip sync", icon: AudioLines },
  { href: "/music", label: "Music", icon: Music },
  { href: "/voice-changer", label: "Voice changer", icon: Wand2 },
  { href: "/interactive", label: "Interactive avatar", icon: MessageSquare },
  { href: "/brand", label: "Brand kit", icon: Palette },
  { href: "/settings", label: "Settings", icon: Settings },
];
