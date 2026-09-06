import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setDraftAttachmentCount } = vi.hoisted(() => ({
  setDraftAttachmentCount: vi.fn(),
}));

vi.mock('../drafts', () => ({ setDraftAttachmentCount }));

import { useImageAttachments } from './attachments';

afterEach(() => {
  setDraftAttachmentCount.mockReset();
  vi.unstubAllGlobals();
});

describe('image attachment ownership', () => {
  it('clears the draft attachment marker on unmount while retaining an accepted file for an in-flight operation', () => {
    const createObjectURL = vi.fn(() => 'blob:image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let current!: ReturnType<typeof useImageAttachments>;
    function Probe() {
      current = useImageAttachments({
        enabled: true,
        busy: false,
        draftId: 'draft-attachments',
        onError: vi.fn(),
      });
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    const file = { name: 'image.png', type: 'image/png', size: 1 } as File;
    act(() => current.selectImages([file]));
    expect(current.attachments[0]?.file).toBe(file);
    expect(setDraftAttachmentCount).toHaveBeenLastCalledWith(
      'draft-attachments',
      1,
    );

    const clearAcceptedFiles = current.clearAttachments;
    act(() => renderer.unmount());
    expect(setDraftAttachmentCount).toHaveBeenLastCalledWith(
      'draft-attachments',
      0,
    );
    expect(current.attachments[0]?.file).toBe(file);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');

    act(() => {
      renderer = create(<Probe />);
    });
    expect(current.attachments).toHaveLength(0);
    act(() => current.selectImages([file]));
    setDraftAttachmentCount.mockClear();
    act(() => clearAcceptedFiles());
    expect(setDraftAttachmentCount).not.toHaveBeenCalled();
    expect(current.attachments[0]?.file).toBe(file);
    act(() => renderer.unmount());
  });
});
