# Program-wide call graph rooted in OBs

The analyzer works on a call graph from every OB down to every block, recording how each call happens (conditional, loop, EN, instance, parameter wiring) and each block's execution context (reaching OBs, priority, cycle time). Many PLC bugs have their cause in a different block than their symptom (a timer frozen by a conditional caller, an instance shared across interrupt priorities), which single-block checks cannot see. Unresolved calls and partial exports never produce errors.
