// Airgap's interface to libjxl: plain C functions over linear memory, no embind
// (embind's generated glue needs eval/new Function, which the app's CSP forbids).
// Every function returns a malloc'd buffer (free with ajxl_free) or NULL on error;
// sizes and image facts are written through the out pointers.
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/version.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

extern "C" {

void ajxl_free(void* p) { free(p); }

uint32_t ajxl_version(void) { return JxlDecoderVersion(); }

static uint8_t* finish(JxlEncoder* enc, size_t* out_size) {
  std::vector<uint8_t> out(64 * 1024);
  uint8_t* next = out.data();
  size_t avail = out.size();
  JxlEncoderStatus st = JXL_ENC_NEED_MORE_OUTPUT;
  while (st == JXL_ENC_NEED_MORE_OUTPUT) {
    st = JxlEncoderProcessOutput(enc, &next, &avail);
    if (st == JXL_ENC_NEED_MORE_OUTPUT) {
      size_t used = next - out.data();
      out.resize(out.size() * 2);
      next = out.data() + used;
      avail = out.size() - used;
    }
  }
  if (st != JXL_ENC_SUCCESS) return nullptr;
  *out_size = next - out.data();
  uint8_t* buf = (uint8_t*)malloc(*out_size);
  memcpy(buf, out.data(), *out_size);
  return buf;
}

// Pixels: interleaved RGBA when has_alpha, else RGB; `bits` 8 or 16 (native-endian uint16 for 16).
// lossless: modular, original colour space, invisible pixels kept exactly.
// Otherwise `distance` (0.1..15, 1 = visually lossless) and `effort` (1..10).
// icc / exif / xmp are optional (size 0 to omit); exif is a bare TIFF blob.
uint8_t* ajxl_encode(const uint8_t* pixels, uint32_t w, uint32_t h, uint32_t bits, int has_alpha, int lossless,
                     float distance, int effort, const uint8_t* icc, size_t icc_size, const uint8_t* exif,
                     size_t exif_size, const uint8_t* xmp, size_t xmp_size, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (!enc) return nullptr;
  uint8_t* result = nullptr;
  do {
    if (exif_size || xmp_size) {
      if (JxlEncoderUseBoxes(enc) != JXL_ENC_SUCCESS) break;
    }
    JxlBasicInfo info;
    JxlEncoderInitBasicInfo(&info);
    info.xsize = w;
    info.ysize = h;
    info.bits_per_sample = bits;
    info.num_color_channels = 3;
    info.alpha_bits = has_alpha ? bits : 0;
    info.num_extra_channels = has_alpha ? 1 : 0;
    info.uses_original_profile = lossless ? JXL_TRUE : JXL_FALSE;
    if (JxlEncoderSetBasicInfo(enc, &info) != JXL_ENC_SUCCESS) break;
    if (icc_size) {
      if (JxlEncoderSetICCProfile(enc, icc, icc_size) != JXL_ENC_SUCCESS) break;
    } else {
      JxlColorEncoding ce;
      JxlColorEncodingSetToSRGB(&ce, JXL_FALSE);
      if (JxlEncoderSetColorEncoding(enc, &ce) != JXL_ENC_SUCCESS) break;
    }
    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, nullptr);
    JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT, effort);
    if (lossless) {
      if (JxlEncoderSetFrameLossless(fs, JXL_TRUE) != JXL_ENC_SUCCESS) break;
      JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_KEEP_INVISIBLE, 1);
    } else {
      if (JxlEncoderSetFrameDistance(fs, distance) != JXL_ENC_SUCCESS) break;
    }
    if (exif_size) {
      std::vector<uint8_t> box(4 + exif_size, 0);  // 4-byte offset to the TIFF header: 0
      memcpy(box.data() + 4, exif, exif_size);
      if (JxlEncoderAddBox(enc, "Exif", box.data(), box.size(), JXL_FALSE) != JXL_ENC_SUCCESS) break;
    }
    if (xmp_size) {
      if (JxlEncoderAddBox(enc, "xml ", xmp, xmp_size, JXL_FALSE) != JXL_ENC_SUCCESS) break;
    }
    if (exif_size || xmp_size) JxlEncoderCloseBoxes(enc);
    // Interleaved RGBA with alpha, RGB without (libjxl requires the channel count to match).
    const uint32_t channels = has_alpha ? 4 : 3;
    JxlPixelFormat pf = {channels, bits == 16 ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    size_t bytes = (size_t)w * h * channels * (bits == 16 ? 2 : 1);
    if (JxlEncoderAddImageFrame(fs, &pf, pixels, bytes) != JXL_ENC_SUCCESS) break;
    JxlEncoderCloseInput(enc);
    result = finish(enc, out_size);
  } while (0);
  JxlEncoderDestroy(enc);
  return result;
}

// Decodes to interleaved RGBA, 8 or 16 bits (16 when the image has more than 8 bits per
// sample), in the image's own colour space (no conversion to sRGB), orientation applied,
// alpha straight. The ICC profile describing the returned samples goes to *icc_out.
uint8_t* ajxl_decode(const uint8_t* data, size_t size, uint32_t* w, uint32_t* h, uint32_t* bits, int* has_alpha,
                     uint32_t* orig_bits, uint8_t** icc_out, size_t* icc_size, size_t* out_size) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) return nullptr;
  uint8_t* pixels = nullptr;
  *icc_out = nullptr;
  *icc_size = 0;
  bool ok = false;
  do {
    if (JxlDecoderSubscribeEvents(dec, JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) break;
    JxlDecoderSetUnpremultiplyAlpha(dec, JXL_TRUE);
    JxlDecoderSetInput(dec, data, size);
    JxlDecoderCloseInput(dec);
    JxlBasicInfo info;
    JxlPixelFormat pf = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
    for (;;) {
      JxlDecoderStatus st = JxlDecoderProcessInput(dec);
      if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) break;
      if (st == JXL_DEC_BASIC_INFO) {
        if (JxlDecoderGetBasicInfo(dec, &info) != JXL_DEC_SUCCESS) break;
        *w = info.xsize;
        *h = info.ysize;
        *orig_bits = info.bits_per_sample;
        *bits = info.bits_per_sample > 8 ? 16 : 8;
        *has_alpha = info.alpha_bits > 0;
        pf.data_type = *bits == 16 ? JXL_TYPE_UINT16 : JXL_TYPE_UINT8;
      } else if (st == JXL_DEC_COLOR_ENCODING) {
        size_t n = 0;
        if (JxlDecoderGetICCProfileSize(dec, JXL_COLOR_PROFILE_TARGET_DATA, &n) == JXL_DEC_SUCCESS && n) {
          *icc_out = (uint8_t*)malloc(n);
          if (JxlDecoderGetColorAsICCProfile(dec, JXL_COLOR_PROFILE_TARGET_DATA, *icc_out, n) == JXL_DEC_SUCCESS) *icc_size = n;
        }
      } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        size_t n = 0;
        if (JxlDecoderImageOutBufferSize(dec, &pf, &n) != JXL_DEC_SUCCESS) break;
        pixels = (uint8_t*)malloc(n);
        *out_size = n;
        if (JxlDecoderSetImageOutBuffer(dec, &pf, pixels, n) != JXL_DEC_SUCCESS) break;
      } else if (st == JXL_DEC_FULL_IMAGE) {
        ok = true;  // first frame only
        break;
      } else if (st == JXL_DEC_SUCCESS) {
        break;
      }
    }
  } while (0);
  JxlDecoderDestroy(dec);
  if (!ok) {
    free(pixels);
    free(*icc_out);
    *icc_out = nullptr;
    *icc_size = 0;
    return nullptr;
  }
  return pixels;
}

// Lossless JPEG recompression: the JPEG's DCT coefficients and every marker are kept
// (reconstruction data in a jbrd box), so ajxl_jxl_to_jpeg gives back the identical file.
uint8_t* ajxl_jpeg_to_jxl(const uint8_t* jpeg, size_t size, int effort, size_t* out_size) {
  JxlEncoder* enc = JxlEncoderCreate(nullptr);
  if (!enc) return nullptr;
  uint8_t* result = nullptr;
  do {
    if (JxlEncoderUseContainer(enc, JXL_TRUE) != JXL_ENC_SUCCESS) break;
    if (JxlEncoderStoreJPEGMetadata(enc, JXL_TRUE) != JXL_ENC_SUCCESS) break;
    JxlEncoderFrameSettings* fs = JxlEncoderFrameSettingsCreate(enc, nullptr);
    JxlEncoderFrameSettingsSetOption(fs, JXL_ENC_FRAME_SETTING_EFFORT, effort);
    if (JxlEncoderAddJPEGFrame(fs, jpeg, size) != JXL_ENC_SUCCESS) break;
    JxlEncoderCloseInput(enc);
    result = finish(enc, out_size);
  } while (0);
  JxlEncoderDestroy(enc);
  return result;
}

uint8_t* ajxl_jxl_to_jpeg(const uint8_t* data, size_t size, size_t* out_size) {
  JxlDecoder* dec = JxlDecoderCreate(nullptr);
  if (!dec) return nullptr;
  std::vector<uint8_t> out;
  bool ok = false;
  do {
    if (JxlDecoderSubscribeEvents(dec, JXL_DEC_JPEG_RECONSTRUCTION | JXL_DEC_FULL_IMAGE) != JXL_DEC_SUCCESS) break;
    JxlDecoderSetInput(dec, data, size);
    JxlDecoderCloseInput(dec);
    bool reconstructing = false;
    for (;;) {
      JxlDecoderStatus st = JxlDecoderProcessInput(dec);
      if (st == JXL_DEC_ERROR || st == JXL_DEC_NEED_MORE_INPUT) break;
      if (st == JXL_DEC_JPEG_RECONSTRUCTION) {
        reconstructing = true;
        out.resize(1 << 16);
        JxlDecoderSetJPEGBuffer(dec, out.data(), out.size());
      } else if (st == JXL_DEC_JPEG_NEED_MORE_OUTPUT) {
        size_t unused = JxlDecoderReleaseJPEGBuffer(dec);
        size_t used = out.size() - unused;
        out.resize(out.size() * 2);
        JxlDecoderSetJPEGBuffer(dec, out.data() + used, out.size() - used);
      } else if (st == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
        break;  // no reconstruction data: not a recompressed JPEG
      } else if (st == JXL_DEC_FULL_IMAGE) {
        if (!reconstructing) break;
        size_t unused = JxlDecoderReleaseJPEGBuffer(dec);
        out.resize(out.size() - unused);
        ok = true;
        break;
      } else if (st == JXL_DEC_SUCCESS) {
        break;
      }
    }
  } while (0);
  JxlDecoderDestroy(dec);
  if (!ok) return nullptr;
  *out_size = out.size();
  uint8_t* buf = (uint8_t*)malloc(out.size());
  memcpy(buf, out.data(), out.size());
  return buf;
}
}
