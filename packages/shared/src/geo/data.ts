// Geographic lookup data: ZIP prefix → state, area code → state, state → zone,
// and the handful of area codes that sit on the other side of a state's
// time-zone line. Kept as plain data so it can be audited and corrected
// without touching logic.

/** [fromPrefix, toPrefix, state] over the first three ZIP digits, inclusive. */
export const ZIP3_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [5, 5, "NY"], [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
  [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"], [206, 212, "MD"], [214, 219, "MD"], [220, 246, "VA"],
  [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 349, "FL"], [350, 369, "AL"],
  [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"],
  [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"], [580, 588, "ND"],
  [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"],
  [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"],
  [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"],
  [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

/** The zone a state is in by default. Split states are resolved in SPLIT_AREA_CODES. */
export const STATE_ZONE: Readonly<Record<string, string>> = {
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", ME: "America/New_York", MD: "America/New_York", MA: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York",
  OH: "America/New_York", PA: "America/New_York", RI: "America/New_York", SC: "America/New_York",
  VT: "America/New_York", VA: "America/New_York", WV: "America/New_York", MI: "America/Detroit",
  IN: "America/Indiana/Indianapolis", KY: "America/New_York", TN: "America/Chicago",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  KS: "America/Chicago", LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", OK: "America/Chicago",
  SD: "America/Chicago", TX: "America/Chicago", WI: "America/Chicago",
  CO: "America/Denver", ID: "America/Boise", MT: "America/Denver", NM: "America/Denver",
  UT: "America/Denver", WY: "America/Denver", AZ: "America/Phoenix",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu", PR: "America/Puerto_Rico",
};

/**
 * Area codes whose zone differs from their state's default. A match here
 * overrides STATE_ZONE. Area codes that straddle a line are listed under the
 * zone most of their population is in and resolve with lower confidence.
 */
export const SPLIT_AREA_CODES: Readonly<Record<string, string>> = {
  // Florida panhandle
  "850": "America/Chicago",
  // Indiana: NW corner (Gary/Hammond) and Evansville are Central
  "219": "America/Chicago",
  "812": "America/Indiana/Indianapolis", // mostly Eastern; Evansville is Central
  // Kentucky: west is Central
  "270": "America/Chicago",
  "364": "America/Chicago",
  // Tennessee: east is Eastern
  "423": "America/New_York",
  "865": "America/New_York",
  // Texas: El Paso is Mountain
  "915": "America/Denver",
  // Nebraska / Kansas / Dakotas: western strips are Mountain, kept Central
  // Idaho: north is Pacific, kept Mountain (America/Boise)
  // Michigan: four UP counties on 906 are Central, kept Eastern
};

/** Area codes that straddle a zone line; a resolution from them is low confidence. */
export const STRADDLING_AREA_CODES: ReadonlySet<string> = new Set([
  "812", "930", "906", "308", "620", "785", "605", "701", "208", "986", "541", "432", "928", "850",
]);

/** Area code → state, for every NANP area code assigned in the US as of 2026. */
export const AREA_CODE_STATE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    AL: "205 251 256 334 659 938",
    AK: "907",
    AZ: "480 520 602 623 928",
    AR: "327 479 501 870",
    CA: "209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951",
    CO: "303 719 720 970 983",
    CT: "203 475 860 959",
    DE: "302",
    DC: "202 771",
    FL: "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
    GA: "229 404 470 478 678 706 762 770 912 943",
    HI: "808",
    ID: "208 986",
    IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872",
    IN: "219 260 317 463 574 765 812 930",
    IA: "319 515 563 641 712",
    KS: "316 620 785 913",
    KY: "270 364 502 606 859",
    LA: "225 318 337 504 985",
    ME: "207",
    MD: "227 240 301 410 443 667",
    MA: "339 351 413 508 617 774 781 857 978",
    MI: "231 248 269 313 517 586 616 679 734 810 906 947 989",
    MN: "218 320 507 612 651 763 924 952",
    MS: "228 601 662 769",
    MO: "235 314 417 557 573 636 660 816 975",
    MT: "406",
    NE: "308 402 531",
    NV: "702 725 775",
    NH: "603",
    NJ: "201 551 609 640 732 848 856 862 908 973",
    NM: "505 575",
    NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
    NC: "252 336 472 704 743 828 910 919 980 984",
    ND: "701",
    OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
    OK: "405 539 572 580 918",
    OR: "458 503 541 971",
    PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878",
    RI: "401",
    SC: "803 821 839 843 854 864",
    SD: "605",
    TN: "423 615 629 731 865 901 931",
    TX: "210 214 254 281 325 346 361 409 430 432 469 512 621 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
    UT: "385 435 801",
    VT: "802",
    VA: "276 434 540 571 686 703 757 804 826 948",
    WA: "206 253 360 425 509 564",
    WV: "304 681",
    WI: "262 274 353 414 534 608 715 920",
    WY: "307",
    PR: "787 939",
  }).flatMap(([state, codes]) => codes.split(" ").map((c) => [c, state] as const)),
);
