from pixel_art_mcp.jobs.log_condense import condense_log


def test_short_log_is_returned_unchanged():
    log = "line1\nline2\nline3"

    assert condense_log(log) == log


def test_empty_log_is_returned_unchanged():
    assert condense_log("") == ""


def test_long_log_without_errors_keeps_only_the_tail():
    lines = [f"progress {i}" for i in range(100)]
    log = "\n".join(lines)

    result = condense_log(log)

    assert "progress 99" in result
    assert "progress 0" not in result
    assert "line(s) omitted" in result


def test_long_log_preserves_an_early_error_outside_the_tail():
    lines = ["Traceback (most recent call last):", "NameError: x is not defined"]
    lines += [f"progress {i}" for i in range(100)]
    log = "\n".join(lines)

    result = condense_log(log)

    assert "Traceback (most recent call last):" in result
    assert "NameError: x is not defined" in result
    assert "progress 99" in result


def test_error_detection_is_case_insensitive():
    lines = ["Example Blender traceback: modeling failed"]
    lines += [f"progress {i}" for i in range(100)]
    log = "\n".join(lines)

    result = condense_log(log)

    assert "Example Blender traceback: modeling failed" in result


def test_caps_the_number_of_error_lines_shown():
    error_lines = [f"Error {i}" for i in range(30)]
    lines = error_lines + [f"progress {i}" for i in range(100)]
    log = "\n".join(lines)

    result = condense_log(log)

    assert "Error 0" not in result
    assert "Error 29" in result
    assert "earlier error line(s) omitted" in result


def test_clips_a_single_pathologically_long_line_in_the_tail():
    lines = [f"progress {i}" for i in range(100)] + ["x" * 5000]
    log = "\n".join(lines)

    result = condense_log(log)

    assert "x" * 5000 not in result
    assert "more chars]" in result
