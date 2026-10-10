"""Shared scene requirements; standard-library-only planning needs no renderer."""

REQUIRED = {
    "title":  ["dur", "title"],
    "bignum": ["dur", "value", "caption"],
    "vchart": ["dur", "data", "caption"],
    "chart":  ["dur", "image", "caption"],
    "hash":   ["dur", "title", "hash", "cta"],
    "question": ["dur", "question"],
    "quote":  ["dur", "label", "quote", "source"],
    "photo":  ["dur", "image", "caption", "source", "origin"],
}

# What a photo scene may claim about itself. A generated image is allowed on
# screen and is ALWAYS labelled — see scene_photo. It may never be presented as
# a record of a real place or event, which is the one editorial rule the
# renderer is able to enforce by itself.
PHOTO_ORIGINS = {"camera", "licensed", "generated"}
