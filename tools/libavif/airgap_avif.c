// Airgap's interface to libavif for image SEQUENCES (animated AVIF). Plain C over linear
// memory, no embind (its glue needs eval, which the app's CSP forbids). Stills keep using
// @jsquash/avif; this module is loaded only for animations.
#include <avif/avif.h>
#include <stdlib.h>
#include <string.h>

void aavif_free(void* p) { free(p); }

const char* aavif_version(void) { return avifVersion(); }

// Decodes every frame to interleaved straight-alpha RGBA at the stored depth (8-bit bytes, or
// native uint16 holding values below 2^depth for 10/12-bit), frames concatenated.
// *durations_out: one double per frame, in units of *timescale (malloc'd).
// *loops: libavif repetitionCount (-1 infinite, -2 unknown).
uint8_t* aavif_decode_frames(const uint8_t* data, size_t size, uint32_t* w, uint32_t* h, uint32_t* depth,
                             uint32_t* out_bits, int* has_alpha, uint32_t* frames, int* loops, double* timescale,
                             double** durations_out, size_t* out_size) {
  avifDecoder* dec = avifDecoderCreate();
  if (!dec) return NULL;
  dec->strictFlags = AVIF_STRICT_DISABLED;
  dec->ignoreExif = AVIF_TRUE;
  dec->ignoreXMP = AVIF_TRUE;
  uint8_t* out = NULL;
  double* durations = NULL;
  int ok = 0;
  if (avifDecoderSetIOMemory(dec, data, size) == AVIF_RESULT_OK && avifDecoderParse(dec) == AVIF_RESULT_OK) {
    *w = dec->image->width;
    *h = dec->image->height;
    *depth = dec->image->depth;
    *out_bits = dec->image->depth > 8 ? 16 : 8;
    *has_alpha = dec->alphaPresent ? 1 : 0;
    *frames = (uint32_t)dec->imageCount;
    *loops = dec->repetitionCount;
    *timescale = (double)dec->timescale;
    size_t frame_bytes = (size_t)(*w) * (*h) * 4 * (*out_bits == 16 ? 2 : 1);
    out = (uint8_t*)malloc(frame_bytes * (*frames));
    durations = (double*)malloc(sizeof(double) * (*frames));
    ok = out && durations;
    for (uint32_t i = 0; ok && i < *frames; i++) {
      if (avifDecoderNextImage(dec) != AVIF_RESULT_OK) { ok = 0; break; }
      avifRGBImage rgb;
      avifRGBImageSetDefaults(&rgb, dec->image);
      rgb.format = AVIF_RGB_FORMAT_RGBA;
      rgb.depth = dec->image->depth;
      rgb.alphaPremultiplied = AVIF_FALSE;
      rgb.pixels = out + frame_bytes * i;
      rgb.rowBytes = (*w) * 4 * (*out_bits == 16 ? 2 : 1);
      if (avifImageYUVToRGB(dec->image, &rgb) != AVIF_RESULT_OK) { ok = 0; break; }
      durations[i] = (double)dec->imageTiming.durationInTimescales;
    }
    *out_size = frame_bytes * (*frames);
  }
  avifDecoderDestroy(dec);
  if (!ok) {
    free(out);
    free(durations);
    return NULL;
  }
  *durations_out = durations;
  return out;
}

// Encodes concatenated RGBA frames (8-bit, or native uint16 with values below 2^depth for
// depth 10/12) with the given timescale and per-frame durations in that timescale. One frame
// gives a still image; more give a sequence.
// lossless: 4:4:4, identity matrix, quantizer lossless. Otherwise `quality` 0..100.
// loops: -1 forever, else the number of repetitions.
uint8_t* aavif_encode_frames(const uint8_t* pixels, uint32_t w, uint32_t h, uint32_t depth, int has_alpha,
                             uint32_t frames, uint32_t timescale, const uint32_t* durations, int loops, int lossless, int quality,
                             int speed, size_t* out_size) {
  avifEncoder* enc = avifEncoderCreate();
  if (!enc) return NULL;
  enc->maxThreads = 1;
  enc->speed = speed;
  enc->timescale = timescale;
  enc->repetitionCount = loops < 0 ? AVIF_REPETITION_COUNT_INFINITE : loops;
  enc->quality = lossless ? AVIF_QUALITY_LOSSLESS : quality;
  enc->qualityAlpha = lossless ? AVIF_QUALITY_LOSSLESS : quality;
  uint32_t in_bits = depth > 8 ? 16 : 8;
  size_t frame_bytes = (size_t)w * h * 4 * (in_bits == 16 ? 2 : 1);
  uint8_t* result = NULL;
  int ok = 1;
  for (uint32_t i = 0; ok && i < frames; i++) {
    avifImage* img = avifImageCreate(w, h, depth, lossless ? AVIF_PIXEL_FORMAT_YUV444 : AVIF_PIXEL_FORMAT_YUV420);
    if (!img) { ok = 0; break; }
    if (lossless) img->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
    img->yuvRange = AVIF_RANGE_FULL;
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, img);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = depth;
    rgb.ignoreAlpha = has_alpha ? AVIF_FALSE : AVIF_TRUE;
    rgb.pixels = (uint8_t*)pixels + frame_bytes * i;
    rgb.rowBytes = w * 4 * (in_bits == 16 ? 2 : 1);
    if (avifImageRGBToYUV(img, &rgb) != AVIF_RESULT_OK) ok = 0;
    else if (avifEncoderAddImage(enc, img, durations[i], frames == 1 ? AVIF_ADD_IMAGE_FLAG_SINGLE : AVIF_ADD_IMAGE_FLAG_NONE) != AVIF_RESULT_OK) ok = 0;
    avifImageDestroy(img);
  }
  avifRWData out = AVIF_DATA_EMPTY;
  if (ok && avifEncoderFinish(enc, &out) == AVIF_RESULT_OK) {
    result = (uint8_t*)malloc(out.size);
    memcpy(result, out.data, out.size);
    *out_size = out.size;
  }
  avifRWDataFree(&out);
  avifEncoderDestroy(enc);
  return result;
}
