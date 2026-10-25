// P3.T1: the ported design-system components keep the bundle's classes, props and accessibility, and render the same
// in RTL (snapshots of the Persian variants). Mirroring is a CSS rule ([dir=rtl] .cp-flip), so the markup must carry
// cp-flip exactly on the direction-bearing glyphs.
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Chip,
  fmt,
  Icon,
  ICON_NAMES,
  IconButton,
  MIRRORED_ICONS,
  PostCard,
  SafetyBanner,
  TabBar,
  Tagged,
  TextField,
  TopBar,
  Urgency,
  avatarSize,
  buttonClass,
  initials,
} from './index';

const rtl = (ui: ReactNode) =>
  render(
    <div dir="rtl" lang="fa">
      {ui}
    </div>,
  );

describe('Icon', () => {
  it('has the 21 core glyphs plus the proposed additions, each drawn with paths', () => {
    for (const core of [
      'home',
      'search',
      'plus',
      'chat',
      'user',
      'heart',
      'comment',
      'share',
      'car',
      'wrench',
      'part',
      'store',
      'star',
      'pin',
      'back',
      'next',
      'arrow',
      'more',
      'check',
      'alert',
      'bell',
    ] as const)
      expect(ICON_NAMES).toContain(core);
    for (const extra of ['close', 'down', 'calendar', 'shield', 'spark', 'map', 'logout', 'send', 'offline', 'sun', 'moon'] as const)
      expect(ICON_NAMES).toContain(extra);
    const { container } = render(
      <>
        {ICON_NAMES.map((n) => (
          <Icon key={n} name={n} />
        ))}
      </>,
    );
    expect(container.querySelectorAll('svg')).toHaveLength(ICON_NAMES.length);
    container.querySelectorAll('svg').forEach((svg) => expect(svg.querySelectorAll('path').length).toBeGreaterThan(0));
  });

  it('mirrors only back, next, arrow, chat, comment, send and logout', () => {
    expect([...MIRRORED_ICONS].sort()).toEqual(['arrow', 'back', 'chat', 'comment', 'logout', 'next', 'send']);
    const { container } = render(
      <>
        <Icon name="back" />
        <Icon name="car" />
      </>,
    );
    const [back, car] = container.querySelectorAll('svg');
    expect(back).toHaveClass('cp-icon', 'cp-flip');
    expect(car).not.toHaveClass('cp-flip');
  });

  it('is decorative unless labelled', () => {
    render(<Icon name="star" label="Rating" filled />);
    expect(screen.getByRole('img', { name: 'Rating' })).toHaveClass('cp-icon-filled');
    const { container } = render(<Icon name="star" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Button', () => {
  it('keeps the bundle classes and loading behaviour', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" size="sm" icon="plus" iconEnd="next" block onClick={onClick}>
        Book
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Book' });
    expect(b).toHaveClass('cp-btn', 'cp-btn-primary', 'cp-btn-sm', 'cp-btn-block');
    expect(b).toHaveAttribute('type', 'button');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
    render(<Button loading>Saving</Button>);
    expect(screen.getByRole('button', { name: 'Saving' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving' })).toHaveAttribute('aria-busy', 'true');
    expect(buttonClass({ variant: 'ghost' })).toBe('cp-btn cp-btn-ghost cp-btn-md');
  });
});

describe('Chip', () => {
  it('toggles with aria-pressed, shows a check when selected, takes a trailing icon', () => {
    const onClick = vi.fn();
    const { container } = render(
      <Chip selected icon="car" onClick={onClick}>
        BMW
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'BMW' });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('cp-chip', 'is-selected');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    render(
      <Chip toggle={false} iconEnd="close" label="Remove brakes">
        Brakes
      </Chip>,
    );
    const action = screen.getByRole('button', { name: 'Remove brakes' });
    expect(action).not.toHaveAttribute('aria-pressed');
  });
});

describe('TextField', () => {
  it('links label, hint and error, keeps auto direction and the prefix/end slots', () => {
    render(<TextField label="Phone" hint="We text a code" prefix={<span>+98</span>} end={<span>✓</span>} inputMode="tel" />);
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('dir', 'auto');
    expect(input).toHaveAccessibleDescription('We text a code');
    expect(screen.getByText('+98')).toBeInTheDocument();
    render(<TextField label="VIN" error="Check the VIN" />);
    const vin = screen.getByLabelText('VIN');
    expect(vin).toHaveAttribute('aria-invalid', 'true');
    expect(vin).toHaveAccessibleDescription('Check the VIN');
    render(<TextField label="Notes" multiline />);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });
});

describe('Avatar, Badge, fmt', () => {
  it('snaps sizes to the CSP-safe steps (no inline style) and draws initials', () => {
    expect(avatarSize(44)).toBe(44);
    expect(avatarSize(36)).toBe(32);
    expect(avatarSize(90)).toBe(96);
    expect(initials('Reza Auto Suspension')).toBe('RA');
    expect(initials('سارا محمدی')).toBe('سم');
    const { container } = render(<Avatar name="Sara M." size={32} ring />);
    const el = container.querySelector('.cp-avatar')!;
    expect(el).toHaveClass('pwa-avatar-32', 'has-ring');
    expect(el.getAttribute('style')).toBeNull();
  });

  it('formats numbers per locale', () => {
    expect(fmt(12, 'fa')).toBe('۱۲');
    expect(fmt(1234)).toBe('1,234');
    render(
      <Badge tone="success" icon="check">
        Verified visit
      </Badge>,
    );
    expect(screen.getByText('Verified visit')).toHaveClass('cp-badge', 'cp-badge-success');
  });
});

describe('Urgency and banners (proposed additions)', () => {
  it('always shows colour, icon and word', () => {
    const { container } = render(<Urgency level="critical" label="Safety-critical" />);
    expect(screen.getByText('Safety-critical')).toHaveClass('cp-badge-danger');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('the safety banner is an alert with its action', () => {
    render(
      <SafetyBanner title="May not be safe to drive" text="Stop driving." action={<Button variant="danger">Find urgent help</Button>} />,
    );
    expect(screen.getByRole('alert')).toHaveClass('pwa-banner', 'is-danger');
    expect(screen.getByRole('button', { name: 'Find urgent help' })).toBeInTheDocument();
    render(<Banner tone="info" title="Note" />);
    expect(screen.getByRole('status')).toHaveTextContent('Note');
  });
});

describe('TopBar, TabBar, IconButton', () => {
  it('TopBar draws a back button only when asked', () => {
    const onBack = vi.fn();
    render(<TopBar title="Silver" onBack={onBack} backLabel="بازگشت" />);
    fireEvent.click(screen.getByRole('button', { name: 'بازگشت' }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Silver' })).toBeInTheDocument();
  });

  it('TabBar marks the active tab and renders links when items have href', () => {
    render(
      <TabBar
        label="Main"
        active="garage"
        items={[
          { id: 'home', label: 'Home', icon: 'home', href: '/fa/home' },
          { id: 'garage', label: 'Garage', icon: 'car', href: '/fa/garage', badge: 'Service due' },
          { id: 'help', label: 'Help Me', icon: 'plus', href: '/fa/help', primary: true },
        ]}
      />,
    );
    const garage = screen.getByRole('link', { name: /Garage/ });
    expect(garage).toHaveAttribute('aria-current', 'page');
    expect(garage).toHaveClass('cp-tab', 'is-active');
    expect(screen.getByRole('img', { name: 'Service due' })).toHaveClass('cp-tab-dot');
    expect(screen.getByRole('link', { name: 'Help Me' })).toHaveClass('is-primary');
  });

  it('IconButton has a label and a count badge', () => {
    render(<IconButton icon="bell" label="Notifications, 4 unread" count="۴" />);
    const b = screen.getByRole('button', { name: 'Notifications, 4 unread' });
    expect(b).toHaveClass('cp-iconbtn', 'pwa-has-badge');
    expect(b.querySelector('.pwa-count')).toHaveTextContent('۴');
  });
});

describe('RTL snapshots', () => {
  it('Button, Chip, Badge, TextField', () => {
    const { container } = rtl(
      <>
        <Button variant="primary" icon="plus" iconEnd="back">
          درخواست نوبت
        </Button>
        <Chip selected>BMW سری ۳</Chip>
        <Badge tone="accent" icon="shield">
          کسب‌وکار تأییدشده
        </Badge>
        <TextField id="f1" label="نام خودرو" hint="مثلاً نقره‌ای" defaultValue="Silver" />
      </>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it('PostCard with Tagged, TopBar and TabBar', () => {
    const { container } = rtl(
      <>
        <TopBar title="گاراژ من" onBack={null} backLabel="بازگشت" />
        <PostCard
          author="تعمیرگاه جلوبندی رضا"
          handle="@reza-auto"
          time="۲ روز پیش"
          text="تعویض طبق پایین جلو راست برای BMW E90."
          role="mechanic"
          verified
          likes={12}
          comments={3}
          liked
          cta="رزرو سرویس"
          locale="fa"
          labels={{ share: 'اشتراک', more: 'بیشتر', roles: { mechanic: 'مکانیک' } }}
          tagged={[
            { icon: 'part', title: 'طبق Meyle HD', detail: 'مناسب BMW سری ۳ E90', price: '۷٬۴۵۰٬۰۰۰ تومان', badge: { text: 'موجود' } },
          ]}
        />
        <Tagged title="تعمیرگاه رضا" detail="تهران، پاسداران" rating={4.8} ratingLabel="امتیاز" locale="fa" />
        <TabBar
          label="اصلی"
          active="home"
          items={[
            { id: 'home', label: 'کشف', icon: 'home' },
            { id: 'help', label: 'کمکم کن', icon: 'plus', primary: true },
          ]}
        />
      </>,
    );
    expect(container.firstChild).toMatchSnapshot();
    expect(screen.getByText('۱۲')).toBeInTheDocument();
  });
});
