import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './Operator.css';

export function About({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="operator-about"
      aria-labelledby="operator-about-title"
      aria-describedby="operator-about-intro"
      onClose={() => {
        onClose();
        openerRef.current?.focus();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>('button, a'),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="operator-about-head">
        <span className="operator-about-diagram" aria-hidden="true">
          <i />
          <span />
          <i />
          <span />
          <i />
        </span>
        <button
          className="btn btn-ghost btn-sm btn-icon"
          type="button"
          aria-label="Close About"
          autoFocus
          onClick={() => dialogRef.current?.close()}
        >
          ×
        </button>
      </header>
      <h2 id="operator-about-title">Break the system. Watch JEV respond.</h2>
      <p id="operator-about-intro">
        breakscale-jev adds automatic JEV repair to Breakscale, the system-design
        simulator by xevrion and contributors. Turn up traffic, crash a service, slow a
        database, or change a component’s settings. JEV watches for trouble and tries to
        repair it while the simulation keeps running.
      </p>
      <h3>You cause the incident</h3>
      <p>
        Select a component and use the damage controls, or turn up the load at the top
        of the canvas. The components, connections and Inspector are editable. Open an
        example from the menu to try a different architecture.
      </p>
      <h3>JEV tries to recover</h3>
      <p>
        Automatic repair starts when JEV is connected. Each decision uses the current
        faults, queues, throughput and latency. The app applies one supported repair,
        then gives the system time to respond. Watch the next measurement to see whether
        it helped. Open Activity to see each chosen action, whether it was applied, and
        its before-and-after measurements. The latest 50 attempts stay here until you
        reload. If no supported repair is available, or repeated waiting makes no
        progress, JEV explains that it needs help. Stop JEV whenever you want to
        experiment on your own.
      </p>
      <p className="operator-about-limit">
        Breakscale computes the traffic and timing. JEV chooses from a bounded repair
        menu; it doesn’t invent simulation results or lower traffic to hide a problem.
        Some architectures and loads exceed those controls. The local demo has a visible
        call limit, pauses decisions with the simulation, and disables JEV during
        challenges. Manual controls work without an API key.
      </p>
      <footer className="operator-about-credit">
        Built on{' '}
        <a href="https://breakscale.tech/" target="_blank" rel="noreferrer">
          Breakscale
        </a>{' '}
        by{' '}
        <a
          href="https://github.com/xevrion/breakscale"
          target="_blank"
          rel="noreferrer"
        >
          xevrion
        </a>
        {' and contributors'}, used under the MIT license. This fork adds automatic JEV
        repair, direct incident controls and measured action history.{' '}
        <a
          href="https://github.com/iamrajjoshi/breakscale-jev"
          target="_blank"
          rel="noreferrer noopener"
        >
          breakscale-jev source on GitHub
        </a>
      </footer>
      <button
        type="button"
        className="btn operator-about-return"
        onClick={() => dialogRef.current?.close()}
      >
        Back to the canvas
      </button>
    </dialog>,
    document.body,
  );
}
