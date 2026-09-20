import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep portalled dialogs usable while their searchable/async contents change. */
export function useModalFocus(
  open: boolean,
  cardRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialRef?: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () =>
      [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.closest('[inert]') && element.getClientRects().length > 0,
      );
    (initialRef?.current ?? controls()[0] ?? card).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0] ?? card;
        const last = items.at(-1) ?? card;
        const active = document.activeElement;
        // A pending async view may have removed the formerly focused button.
        if (
          !card.contains(active) ||
          active === card ||
          (event.shiftKey ? active === first : active === last)
        ) {
          event.preventDefault();
          event.stopPropagation();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !card.contains(event.target))
        (controls()[0] ?? card).focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      const active = document.activeElement;
      if (
        opener?.isConnected &&
        (!active || active === document.body || card.contains(active))
      )
        opener.focus();
    };
  }, [open, cardRef, initialRef]);
}
