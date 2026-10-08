import type * as React from 'react';

/** Icon names drawn for CarPal (24px grid, 2px stroke). back, next, arrow, chat, comment mirror under dir="rtl". */
export type IconName = 'home' | 'search' | 'plus' | 'chat' | 'user' | 'heart' | 'comment' | 'share' | 'car' | 'wrench' | 'part' | 'store' | 'star' | 'pin' | 'back' | 'next' | 'arrow' | 'more' | 'check' | 'alert' | 'bell';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = signal fill, once per screen. Default secondary. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** md = 48px (default), sm = 40px. */
  size?: 'md' | 'sm';
  icon?: IconName; iconEnd?: IconName; block?: boolean; loading?: boolean;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconProps { name: IconName; size?: number; filled?: boolean; /** Give a label only when the icon stands alone and carries meaning. */ label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; multiline?: boolean; icon?: IconName;
}
export declare function TextField(props: TextFieldProps): React.ReactElement;

export interface ChipProps { selected?: boolean; icon?: IconName; onClick?: () => void; children?: React.ReactNode; className?: string }
export declare function Chip(props: ChipProps): React.ReactElement;

export interface BadgeProps { tone?: 'neutral' | 'signal' | 'accent' | 'success' | 'danger'; icon?: IconName; children?: React.ReactNode; className?: string }
export declare function Badge(props: BadgeProps): React.ReactElement;

export interface AvatarProps { name: string; src?: string; size?: number; /** signal ring = verified mechanic or seller */ ring?: boolean; className?: string }
export declare function Avatar(props: AvatarProps): React.ReactElement;

export interface TaggedProps {
  /** wrench = a mechanic's shop, part = a spare part, store = a parts shop */ icon?: IconName;
  title: string; /** place, or which cars the part fits */ detail?: string;
  /** 0–5, shown with a filled star */ rating?: number; ratingLabel?: string;
  /** already formatted, e.g. "1,850,000 T" */ price?: string;
  badge?: { text: string; tone?: BadgeProps['tone']; icon?: IconName };
  locale?: 'en' | 'fa';
}
export declare function Tagged(props: TaggedProps): React.ReactElement;

export interface PostCardProps {
  author: string; handle: string; time: string; text: string; avatar?: string;
  /** Who is speaking: shows a role badge beside the name. */ role?: 'owner' | 'mechanic' | 'seller';
  /** signal ring on the avatar */ verified?: boolean;
  /** Mechanics, shops or parts mentioned in the post. */ tagged?: TaggedProps[];
  likes?: number; comments?: number; liked?: boolean;
  /** Primary call to action, e.g. "Book service". */ cta?: string; highlight?: boolean;
  /** 'fa' renders counts in Persian digits. */ locale?: 'en' | 'fa'; lang?: string;
  labels?: { share?: string; more?: string; roles?: { owner?: string; mechanic?: string; seller?: string } };
}
export declare function PostCard(props: PostCardProps): React.ReactElement;

export interface TopBarProps { title: React.ReactNode; onBack?: (() => void) | null; backLabel?: string; actions?: React.ReactNode; className?: string }
export declare function TopBar(props: TopBarProps): React.ReactElement;

export interface TabBarItem { id: string; label: string; icon: IconName; badge?: string; primary?: boolean }
export interface TabBarProps { items: TabBarItem[]; active: string; onChange?: (id: string) => void; label?: string; className?: string }
export declare function TabBar(props: TabBarProps): React.ReactElement;

/** Locale-aware number: fmt(12, 'fa') → "۱۲". */
export declare function fmt(n: number, locale?: 'en' | 'fa' | string): string;

declare global { interface Window { CarPal: { Button: typeof Button; Icon: typeof Icon; TextField: typeof TextField; Chip: typeof Chip; Badge: typeof Badge; Avatar: typeof Avatar; PostCard: typeof PostCard; Tagged: typeof Tagged; TopBar: typeof TopBar; TabBar: typeof TabBar; fmt: typeof fmt } } }
