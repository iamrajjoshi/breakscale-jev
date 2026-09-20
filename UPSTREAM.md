# Upstream attribution

Switchyard is based on [Breakscale](https://github.com/xevrion/breakscale) by xevrion and contributors. Its Git history and original authorship are retained. The integration baseline is commit `3ce685bddd8cfba85bd6c2059df935072383b913`, retrieved on 2026-09-19.

Breakscale provides the canvas, component catalog, examples, challenges, discrete-event engine, glossary, layout and tests. The 30 files under `src/sim` remain unchanged from that baseline. The original MIT copyright and license remain in [LICENSE](LICENSE), and the Caveat font retains its bundled [SIL Open Font License](public/fonts/Caveat/OFL.txt). Upstream community documentation and artwork remain included.

This fork adds the bounded JEV repair watcher, server-side TypeSafe integration, direct incident controls, measured Activity history and related UI fixes and tests. JEV chooses from legal actions; upstream simulation code computes the outcomes. These additions do not establish optimal control or superiority over a conventional controller.

The local app does not enable upstream hosted sharing or analytics. Its server binds to loopback, and no hosted Switchyard deployment is implied. The public fork is [iamrajjoshi/switchyard](https://github.com/iamrajjoshi/switchyard), linked to the original Breakscale repository on GitHub.
