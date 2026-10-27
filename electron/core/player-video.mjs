// gpu-next/libplacebo keeps Dolby Vision reshaping and dynamic metadata in the
// same color-managed path as HDR10. Never force PQ onto an SDR desktop or invent
// a panel brightness: DXGI supplies the active output and calibrated luminance.
export function videoOutputArguments(platform = process.platform) {
  return ['--vo=gpu-next', ...(platform === 'win32' ? ['--gpu-api=d3d11', '--gpu-context=d3d11', '--d3d11-output-mode=window'] : []),
    '--target-colorspace-hint=auto', '--target-colorspace-hint-mode=target', '--target-colorspace-hint-strict=yes',
    '--target-prim=auto', '--target-trc=auto', '--target-peak=auto', '--hdr-reference-white=auto',
    '--hdr-compute-peak=yes', '--tone-mapping=auto', '--gamut-mapping-mode=auto', '--inverse-tone-mapping=no',
    '--scale=ewa_lanczossharp', '--scale-antiring=0.6', '--dither-depth=auto'];
}

const number = value => Number.isFinite(value) && value > 0 ? value : undefined;
const text = value => typeof value === 'string' ? value.slice(0, 80) : undefined;
const hdr = params => ['pq', 'hlg', 'scrgb'].includes(params?.gamma) || params?.gamma === 'linear' && /(?:f16|f32|16f|32f)/i.test(params?.pixelformat ?? '');

export function videoPlaybackStatus(session) {
  const input = session.videoParams, output = session.videoTarget;
  const dolbyVision = input?.colormatrix === 'dolbyvision';
  const source = !input ? null : dolbyVision ? 'Dolby Vision' : input.gamma === 'pq' ? 'HDR10' : input.gamma === 'hlg' ? 'HLG' : 'SDR';
  const target = !output ? null : hdr(output) ? 'HDR' : 'SDR';
  return {source, output: target, mapped: Boolean(source && target && (dolbyVision || source !== 'SDR' && target === 'SDR')),
    dolbyVisionProfile: number(session.dolbyVisionProfile), nativeDolbyVision: false,
    peakNits: number(output?.['max-luma']), outputTransfer: text(output?.gamma), outputPrimaries: text(output?.primaries),
    pixelFormat: text(output?.pixelformat), decoder: text(session.hwdec), renderer: text(session.vo)};
}
