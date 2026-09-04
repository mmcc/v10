import { audioTrackFeature } from './audio-track';
import { bufferFeature } from './buffer';
import { captureDevicesFeature } from './capture-devices';
import { captureSourceFeature } from './capture-source';
import { captureTracksFeature } from './capture-tracks';
import { controlsFeature } from './controls';
import { fullscreenFeature } from './fullscreen';
import { liveFeature } from './live';
import { metadataFeature } from './metadata';
import { orientationLockFeature } from './orientation-lock';
import { pipFeature } from './pip';
import { playbackFeature } from './playback';
import { playbackRateFeature } from './playback-rate';
import { publishFeature } from './publish';
import { publishStatsFeature } from './publish-stats';
import { qualityFeature } from './quality';
import { remotePlaybackFeature } from './remote-playback';
import { sourceFeature } from './source';
import { streamTypeFeature } from './stream-type';
import { textTrackFeature } from './text-track';
import { timeFeature } from './time';
import { volumeFeature } from './volume';

export { audioFeatures, backgroundFeatures, videoFeatures } from './presets';

// Short aliases
export {
  audioTrackFeature as audioTrack,
  bufferFeature as buffer,
  captureDevicesFeature as captureDevices,
  captureSourceFeature as captureSource,
  captureTracksFeature as captureTracks,
  controlsFeature as controls,
  fullscreenFeature as fullscreen,
  liveFeature as live,
  metadataFeature as metadata,
  orientationLockFeature as orientationLock,
  pipFeature as pip,
  playbackFeature as playback,
  playbackRateFeature as playbackRate,
  publishFeature as publish,
  publishStatsFeature as publishStats,
  qualityFeature as quality,
  remotePlaybackFeature as remotePlayback,
  sourceFeature as source,
  streamTypeFeature as streamType,
  textTrackFeature as textTrack,
  timeFeature as time,
  volumeFeature as volume,
};
