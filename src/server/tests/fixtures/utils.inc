; Utility macros and constants
SCREEN_WIDTH EQU 160
SCREEN_HEIGHT EQU 144

CopyBytes:
    ld a, [hli]
    ld [de], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, CopyBytes
    ret
