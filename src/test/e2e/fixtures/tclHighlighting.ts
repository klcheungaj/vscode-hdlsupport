// SPDX-License-Identifier: MIT

/**
 * Sources whose TextMate highlighting must match Softbrush semantic tokens
 * (`softbrush.e2e.test.ts`). Each covers the constructs Softbrush classifies.
 */

const SHARED_TCL = [
    '#!/usr/bin/env tclsh',
    '# comment line with $var [cmd] {braces} "quotes"',
    'set x 10',
    'set y -3.5e2',
    'set z +.5; set w 1e3 ;# trailing comment',
    'set name "value $x and [expr {$x + 1}] done"',
    'set arr(key) ${x}',
    'set list {a b {c d}}',
    'set only',
    'puts $arr(key) ; puts -nonewline stdout "x\\n"',
    'string match -nocase "*a*" abc',
    'proc add {a {b 2} args} {',
    '    return [expr {$a + $b}]',
    '}',
    'proc ::util::noop {} {}',
    'if {$x > 5} {',
    '    puts big',
    '} elseif {$x < 0} { puts neg } else { puts small }',
    'foreach item $list { lappend out $item }',
    'while {$x > 0} { incr x -1 }',
    'namespace eval ::util { variable count 0 }',
    'variable total',
    'catch {error oops} message',
    'set result [lindex [split $name " "] 0]',
    'puts "nested \\"quote\\" and \\$escaped"',
    '$handler arg1 -opt 2',
    'lappend items [list 1 2 3] \\',
    '    -flag value',
    'set multi "line one',
    'line two $x"',
    'set data {',
    '    first',
    '    {second}',
    '}',
    'expr {inf + nan}',
];

const SHARED_CONSTRAINTS = [
    '# clocks',
    'create_clock -name sys_clk -period 10.0 -waveform {0 5} [get_ports clk]',
    'create_generated_clock -name div2 -source [get_pins pll/CLKIN] -divide_by 2 [get_pins pll/CLKOUT]',
    'create_clock -period 8 [get_ports {rx_clk}]',
    'create_clock -period 4 [get_ports "tx_clk"]',
    'create_clock -name {spaced clk} -period 3',
    'create_clock -name "quoted_clk" -period 3',
    'set_input_delay -clock sys_clk -max 2.5 [get_ports {data[*]}]',
    'set_output_delay -clock "div2" 1 [all_outputs]',
    'set_clock_groups -asynchronous -group {sys_clk} -group [get_clocks div2]',
    'set_false_path -from [get_clocks sys_clk] -to [get_clocks rx_clk]',
    'set_false_path -from {sys_clk} -to "rx_clk"',
    'set_multicycle_path 2 -setup -from [get_cells a/b*] -to [get_cells c/d*]',
    'set_clock_uncertainty 0.2 [get_clocks sys_clk]',
    'set_clock_latency -source 1.5 {sys_clk}',
    'set_propagated_clock [all_clocks]',
    'get_clocks -filter {NAME =~ sys*}',
    'set period 10',
    'set_max_delay $period -from [get_cells a/b*]',
    'my_vendor_cmd -opt value',
    'if {$period > 5} { set_multicycle_path 2 -setup -to [get_pins x] }',
    'proc helper {a {b {1 2}}} { return $a }',
    'set_property -dict {PACKAGE_PIN U16 IOSTANDARD LVCMOS33} [get_ports {led[0]}]',
    '',
];

/** Each dialect gets every construct: Softbrush classifies them per dialect. */
export const TCL_HIGHLIGHT_SOURCES = {
    tcl: [...SHARED_TCL, ...SHARED_CONSTRAINTS].join('\n'),
    sdc: [...SHARED_TCL, ...SHARED_CONSTRAINTS, 'set_load 0.5 [all_outputs]', ''].join('\n'),
    xdc: [
        ...SHARED_TCL,
        ...SHARED_CONSTRAINTS,
        'set_property PACKAGE_PIN W5 [get_ports clk]',
        'create_clock -add -name sys_clk_pin -period 10.00 -waveform {0 5} [get_ports clk]',
        'create_pblock pblock_1',
        'resize_pblock [get_pblocks pblock_1] -add {SLICE_X0Y0:SLICE_X10Y10}',
        'set_property CFGBVS VCCO [current_design]',
        '',
    ].join('\n'),
} as const;
