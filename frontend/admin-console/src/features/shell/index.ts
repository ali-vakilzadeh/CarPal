// The shell's public surface for other features and the admin kit (AC5): shortcuts, step-up with replay, sections
// and role names. Features import it through this index only (eslint no-restricted-imports).
export { useShortcut, useOpenShortcutHelp, type ShortcutId } from './shortcuts';
export { useStepUp, useIntentHandler, needsStepUp, type StepUpAction, type StepUpResult, type IntentHandler } from './step-up';
export { SECTIONS, canOpen, rolesFor, sectionBySlug, visibleSections, type Section, type SectionId } from './sections';
export { roleNames, STAFF_ROLE_ORDER } from './roles';
