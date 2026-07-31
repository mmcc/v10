import { CapturePlaceholderElement } from '../../ui/capture-placeholder/capture-placeholder-element';
import { safeDefine } from '../safe-define';

safeDefine(CapturePlaceholderElement);

declare global {
  interface HTMLElementTagNameMap {
    [CapturePlaceholderElement.tagName]: CapturePlaceholderElement;
  }
}
