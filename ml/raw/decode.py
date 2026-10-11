"""Optional native RAW decoder. Input/output paths are supplied by the local worker."""
import sys
try:
    import rawpy
    from PIL import Image
except ImportError as error:
    print('optional rawpy/Pillow unavailable: ' + str(error), file=sys.stderr)
    sys.exit(3)

with rawpy.imread(sys.argv[1]) as raw:
    # Disable LibRaw rotation; Node applies the source EXIF orientation exactly once.
    pixels = raw.postprocess(use_camera_wb=True, no_auto_bright=True,
                             output_bps=8, user_flip=0)
Image.fromarray(pixels).save(sys.argv[2], quality=96)
