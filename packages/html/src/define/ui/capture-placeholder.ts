import { safeDefine } from '../../registration/safe-define';
import { CapturePlaceholderElement } from '../../ui/capture-placeholder/capture-placeholder-element';

safeDefine(CapturePlaceholderElement);

declare global {
  interface HTMLElementTagNameMap {
    [CapturePlaceholderElement.tagName]: CapturePlaceholderElement;
  }
}
