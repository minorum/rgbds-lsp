SECTION "Main", ROM0[$0100]

Main::
    call InitSystem
    jr Main

InitSystem:
    ld a, $00
    ld [rLCDC], a
.waitVBlank:
    ld a, [rLY]
    cp $90
    jr nz, .waitVBlank
    ret

PLAYER_MAX_HP EQU $64
