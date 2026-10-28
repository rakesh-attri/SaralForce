// Client-side polling stopped (tab unmounted). The server job is untouched.
const FF_STOPPED_MSG = "Stopped waiting (view closed)";
function ffStoppedError() {
  const e = new Error(FF_STOPPED_MSG);
  e.ffStopped = true;
  return e;
}
function ffIsStopped(e) {
  return !!(e && e.ffStopped);
}
// setTimeout that rejects with ffStoppedError() as soon as `signal` aborts.
function ffSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(ffStoppedError()); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(ffStoppedError());
    }
    if (signal) signal.addEventListener("abort", onAbort, {once: true});
  });
}
// AbortController aborted when the calling component unmounts; long loops
// pass ref.current.signal so they stop instead of setting state on a dead tab.
function useUnmountSignal() {
  const ref = React.useRef(null);
  if (!ref.current) ref.current = new AbortController();
  React.useEffect(() => {
    if (ref.current.signal.aborted) ref.current = new AbortController();
    const ac = ref.current;
    return () => ac.abort();
  }, []);
  return ref;
}

export {ffStoppedError, ffIsStopped, ffSleep, useUnmountSignal};
