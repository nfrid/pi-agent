import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setDraftAttachmentCount } = vi.hoisted(() => ({
  setDraftAttachmentCount: vi.fn(),
}));

vi.mock('@pi-dashboard/protocol/pi-runtime-protocol', () => ({
  IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/webp'],
  MAX_ATTACHMENT_COUNT: 4,
  MAX_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  MAX_ATTACHMENT_TOTAL_BYTES: 12 * 1024 * 1024,
}));
vi.mock('../drafts', () => ({ setDraftAttachmentCount }));

import { FileAttachmentPreviews, useFileAttachments } from './attachments';

afterEach(() => {
  setDraftAttachmentCount.mockReset();
  vi.unstubAllGlobals();
});

describe('file attachment selection', () => {
  it('keeps generic files and native image previews in one removable selection', () => {
    const createObjectURL = vi.fn(() => 'blob:image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let current!: ReturnType<typeof useFileAttachments>;
    function Probe() {
      current = useFileAttachments({
        enabled: true,
        busy: false,
        onError: vi.fn(),
      });
      return (
        <FileAttachmentPreviews
          attachments={current.attachments}
          busy={false}
          onRemove={current.removeFile}
        />
      );
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    const note = new File([], 'readme.md', { type: 'text/markdown' });
    const image = new File(['png'], 'photo.png', { type: 'image/png' });
    act(() => current.selectFiles([note, image]));

    expect(current.attachments.map(({ file }) => file)).toEqual([note, image]);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(
      renderer.root.findAll(
        (node) => node.type === 'span' && node.children.includes('readme.md'),
      ),
    ).toHaveLength(1);
    expect(
      renderer.root.findAll(
        (node) => node.type === 'span' && node.children.includes('0 B'),
      ),
    ).toHaveLength(1);
    expect(renderer.root.findByType('img').props.alt).toBe('photo.png');
    expect(renderer.root.findAllByType('button')).toHaveLength(2);

    const firstAttachment = current.attachments[0];
    if (!firstAttachment) throw new Error('Missing selected attachment');
    act(() => current.removeFile(firstAttachment.id));
    expect(current.attachments.map(({ file }) => file)).toEqual([image]);
    act(() => renderer.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image');
  });

  it('retains selected files through unmount while clearing draft ownership', () => {
    const createObjectURL = vi.fn(() => 'blob:image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let current!: ReturnType<typeof useFileAttachments>;
    function Probe() {
      current = useFileAttachments({
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
    const file = new File(['image'], 'image.png', { type: 'image/png' });
    act(() => current.selectFiles([file]));
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
    act(() => current.selectFiles([file]));
    setDraftAttachmentCount.mockClear();
    act(() => clearAcceptedFiles());
    expect(setDraftAttachmentCount).not.toHaveBeenCalled();
    expect(current.attachments[0]?.file).toBe(file);
    act(() => renderer.unmount());
  });
});
