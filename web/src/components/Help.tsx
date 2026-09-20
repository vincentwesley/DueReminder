import { setState } from '../store';
import { Dialog } from './Dialog';

const KEYS: [string, string][] = [
  ['n', 'New reminder'], ['/', 'Focus search'], ['a', 'Focus quick add'], ['j / k', 'Next / previous reminder'],
  ['e', 'Edit selected reminder'], ['x', 'Complete selected reminder'], ['?', 'Show this help'], ['Esc', 'Close dialog'],
];

export default function Help() {
  return (
    <Dialog label="Keyboard shortcuts" onClose={() => setState({ helpOpen: false })} testId="help-dialog">
      <div className="panel">
        <dl className="keys">
          {KEYS.map(([k, d]) => (
            <div key={k}><dt>{k.split(' / ').map((x, i) => <span key={x}>{i > 0 && ' / '}<kbd>{x}</kbd></span>)}</dt><dd>{d}</dd></div>
          ))}
        </dl>
      </div>
    </Dialog>
  );
}
